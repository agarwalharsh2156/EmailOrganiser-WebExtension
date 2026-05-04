import os
import joblib
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List
from preprocessor import preprocess

# ── Load artifact once at startup ────────────────────────────────
artifact  = joblib.load("email_classifier.pkl")
model     = artifact['model']
tfidf     = artifact['tfidf']
le        = artifact['label_encoder']
THRESHOLD = artifact['metadata'].get('confidence_threshold', 0.60)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # Chrome extension has no fixed origin
    allow_methods=["POST"],
    allow_headers=["Content-Type"],
)

# ── Request / Response schemas ────────────────────────────────────
class EmailItem(BaseModel):
    message_id: str
    subject:    str
    body:       str
    from_:      str = ""   # 'from' is a Python keyword

class BatchRequest(BaseModel):
    emails: List[EmailItem]

class PredictionResult(BaseModel):
    message_id:      str
    predicted_class: str
    confidence:      float

class BatchResponse(BaseModel):
    results: List[PredictionResult]

# ── Endpoint ──────────────────────────────────────────────────────
@app.post("/classify-batch", response_model=BatchResponse)
def classify_batch(request: BatchRequest):
    if not request.emails:
        raise HTTPException(status_code=400, detail="No emails provided")

    # Preprocess all emails — matches training pipeline exactly
    texts = [preprocess(e.subject, e.body) for e in request.emails]

    # Single vectorizer + model call for entire batch
    vectors     = tfidf.transform(texts)
    probas      = model.predict_proba(vectors)

    results = []
    for i, email in enumerate(request.emails):
        confidence      = float(probas[i].max())
        predicted_class = le.classes_[probas[i].argmax()]

        # Apply confidence threshold — same logic as notebook's predict_single
        if confidence < THRESHOLD:
            predicted_class = "Unclassified"

        results.append(PredictionResult(
            message_id=email.message_id,
            predicted_class=predicted_class,
            confidence=round(confidence, 4)
        ))

    return BatchResponse(results=results)

@app.get("/health")
def health():
    return {"status": "ok", "categories": list(le.classes_)}