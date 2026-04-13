import os
import uuid
import json
import math
import asyncio
import requests
import numpy as np
from datetime import datetime
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from pypdf import PdfReader
import fitz
from pydantic import BaseModel
from typing import List, Optional

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = "uploads"
PAGES_DIR = os.path.join("public", "pages")
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(PAGES_DIR, exist_ok=True)

OLLAMA_BASE = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "nomic-embed-text")
CHAT_MODEL = os.environ.get("CHAT_MODEL", "llama3.2")

# --- Ollama API Helpers ---
async def get_embedding(text: str) -> List[float]:
    try:
        res = await asyncio.to_thread(
            requests.post, f"{OLLAMA_BASE}/api/embed", json={"model": EMBED_MODEL, "input": text}
        )
        res.raise_for_status()
        return res.json().get("embeddings")[0]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Ollama embed error: {str(e)}")

def chat_with_ollama(messages: List[dict]) -> str:
    try:
        res = requests.post(
            f"{OLLAMA_BASE}/api/chat",
            json={"model": CHAT_MODEL, "messages": messages, "stream": False}
        )
        res.raise_for_status()
        return res.json().get("message", {}).get("content", "")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Ollama chat error: {str(e)}")

# --- Text Chunking ---
def chunk_text(text: str, chunk_size: int = 500, overlap: int = 100) -> List[str]:
    chunks = []
    clean_text = ' '.join(text.split()).strip()
    if not clean_text:
        return chunks

    start = 0
    while start < len(clean_text):
        end = min(start + chunk_size, len(clean_text))

        if end < len(clean_text):
            slice_text = clean_text[start:end]
            last_period = slice_text.rfind('. ')
            last_question = slice_text.rfind('? ')
            last_exclaim = slice_text.rfind('! ')
            break_point = max(last_period, last_question, last_exclaim)

            if break_point > chunk_size * 0.3:
                end = start + break_point + 2

        chunk = clean_text[start:end].strip()
        if chunk:
            chunks.append(chunk)

        next_start = end - overlap
        if next_start <= start:
            start = end
        else:
            start = next_start

    return chunks

# --- In-Memory Vector Store ---
class VectorStore:
    def __init__(self):
        self.entries = []
    
    def add(self, id, docId, docName, chunkIndex, pageNumber, text, embedding):
        self.entries.append({
            "id": id,
            "docId": docId,
            "docName": docName,
            "chunkIndex": chunkIndex,
            "pageNumber": pageNumber,
            "text": text,
            "embedding": np.array(embedding)
        })

    def delete_by_doc_id(self, docId):
        self.entries = [e for e in self.entries if e["docId"] != docId]

    @staticmethod
    def cosine(a: np.ndarray, b: np.ndarray) -> float:
        mag_a = np.linalg.norm(a)
        mag_b = np.linalg.norm(b)
        if mag_a == 0 or mag_b == 0:
            return 0.0
        return float(np.dot(a, b) / (mag_a * mag_b))

    def query(self, query_embedding: List[float], top_k: int = 5):
        if not self.entries:
            return []
        
        qe = np.array(query_embedding)
        all_embeddings = np.array([e["embedding"] for e in self.entries])
        
        # Vectorized cosine similarity
        mags = np.linalg.norm(all_embeddings, axis=1)
        qe_mag = np.linalg.norm(qe)
        
        valid_mask = (mags != 0) & (qe_mag != 0)
        scores = np.zeros(len(self.entries))
        
        if qe_mag != 0:
            dots = np.dot(all_embeddings, qe)
            scores[valid_mask] = dots[valid_mask] / (mags[valid_mask] * qe_mag)
            
        scored = []
        for i, e in enumerate(self.entries):
            scored.append({**e, "score": float(scores[i])})
            
        scored.sort(key=lambda x: x["score"], reverse=True)
        return scored[:top_k]

    @property
    def size(self):
        return len(self.entries)

vector_store = VectorStore()
documents = {} # docId -> {name, filename, chunkCount, pages, uploadedAt}

# --- API Routes ---

@app.post("/api/upload")
async def upload_pdf(pdf: UploadFile = File(...)):
    if not pdf.filename or not pdf.filename.endswith('.pdf'):
        raise HTTPException(status_code=400, detail="Only PDF files are allowed")

    docId = str(uuid.uuid4())
    ext = os.path.splitext(pdf.filename)[1]
    filename = f"{int(datetime.now().timestamp())}-{docId}{ext}"
    file_path = os.path.join(UPLOAD_DIR, filename)
    
    try:
        with open(file_path, "wb") as f:
            f.write(await pdf.read())
            
        # Parse PDF
        reader = PdfReader(file_path)
        doc_fitz = fitz.open(file_path)
        all_chunks = []
        for page_num, page in enumerate(reader.pages):
            # Render image of the page
            fitz_page = doc_fitz[page_num]
            pix = fitz_page.get_pixmap(matrix=fitz.Matrix(2, 2))  # Higher resolution matrix
            image_path = os.path.join(PAGES_DIR, f"{docId}_page_{page_num + 1}.png")
            pix.save(image_path)
            
            extr = page.extract_text()
            if extr:
                page_chunks = chunk_text(extr)
                for chunk in page_chunks:
                    all_chunks.append({
                        "pageNumber": page_num + 1,
                        "text": chunk
                    })
                
        doc_fitz.close()
                
        if not all_chunks:
            os.remove(file_path)
            raise HTTPException(status_code=400, detail="Could not extract text from PDF. It may be scanned/image-based.")
            
        async def process_chunk(i, chunk_data):
            chunk_str = chunk_data["text"]
            page_num = chunk_data["pageNumber"]
            embedding = await get_embedding(chunk_str)
            return (i, page_num, chunk_str, embedding)

        processed = await asyncio.gather(*(process_chunk(i, c) for i, c in enumerate(all_chunks)))
        
        for i, page_num, chunk_str, embedding in processed:
            vector_store.add(
                f"{docId}_chunk_{i}",
                docId,
                pdf.filename,
                i,
                page_num,
                chunk_str,
                embedding
            )

        documents[docId] = {
            "name": pdf.filename,
            "filename": filename,
            "chunkCount": len(all_chunks),
            "pages": len(reader.pages),
            "uploadedAt": datetime.now().isoformat()
        }

        os.remove(file_path)

        return {
            "success": True,
            "docId": docId,
            "name": pdf.filename,
            "chunks": len(all_chunks),
            "pages": len(reader.pages)
        }

    except Exception as e:
        if os.path.exists(file_path):
            os.remove(file_path)
        raise HTTPException(status_code=500, detail=str(e))


class ChatRequest(BaseModel):
    question: str
    history: Optional[List[dict]] = []

@app.post("/api/chat")
async def chat(request: ChatRequest):
    question = request.question.strip()
    history = request.history or []
    
    if not question:
        raise HTTPException(status_code=400, detail="Question is required")

    if not documents:
        return {
            "answer": "I don't have any documents to reference yet. Please upload a PDF first, and then I can answer questions about it!",
            "sources": []
        }

    question_embedding = await get_embedding(question)
    results = vector_store.query(question_embedding, 5)

    context = "\n\n---\n\n".join([
        f"[Source: {r['docName']}, Page {r['pageNumber']} (similarity: {r['score']:.3f})]\n{r['text']}" 
        for r in results
    ])

    system_prompt = (
        "You are a helpful study assistant. Answer the student's question based ONLY on the provided context from their uploaded documents. "
        "If the context doesn't contain enough information to answer the question, say so honestly. "
        "Always cite which document and page number the information comes from when possible. "
        "Be clear, concise, and educational in your responses. "
        "Format your responses with markdown for readability."
    )

    messages = [{"role": "system", "content": system_prompt}] + history[-6:] + [{
        "role": "user",
        "content": f"Context from uploaded documents:\n\n{context}\n\n---\n\nStudent's Question: {question}"
    }]

    answer = chat_with_ollama(messages)
    
    unique_sources = {}
    for r in results:
        key = f"{r['docId']}_{r['pageNumber']}"
        if key not in unique_sources:
            unique_sources[key] = {
                "name": r['docName'],
                "page": r['pageNumber'],
                "image": f"/pages/{r['docId']}_page_{r['pageNumber']}.png"
            }
            
    sources = list(unique_sources.values())

    return {"answer": answer, "sources": sources, "chunks_used": len(results)}


@app.get("/api/documents")
async def get_documents():
    return [{"id": k, **v} for k, v in documents.items()]

@app.delete("/api/documents/{doc_id}")
async def delete_document(doc_id: str):
    if doc_id not in documents:
        raise HTTPException(status_code=404, detail="Document not found")
    
    doc = documents[doc_id]
    vector_store.delete_by_doc_id(doc_id)
    del documents[doc_id]
    
    # Clean up images
    for i in range(doc["pages"]):
        img_path = os.path.join(PAGES_DIR, f"{doc_id}_page_{i + 1}.png")
        if os.path.exists(img_path):
            os.remove(img_path)
            
    return {"success": True, "message": f"Deleted \"{doc['name']}\""}


# Serve static files matching Express behavior
app.mount("/", StaticFiles(directory="public", html=True), name="public")
