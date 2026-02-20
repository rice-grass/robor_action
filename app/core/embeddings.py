import json
import asyncio
import urllib.request
from typing import List, Optional

from app.config import get_settings

settings = get_settings()


class EmbeddingModel:
    def __init__(self, model_name: Optional[str] = None):
        self.model_name = model_name or settings.embedding_model
        self.base_url = settings.ollama_host

    def _embed_sync(self, text: str) -> List[float]:
        url = f"{self.base_url}/api/embeddings"
        payload = {"model": self.model_name, "prompt": text}
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            obj = json.loads(resp.read().decode("utf-8"))
            return obj.get("embedding", [])

    async def embed_query(self, text: str) -> List[float]:
        return await asyncio.to_thread(self._embed_sync, text)

    async def embed_documents(self, texts: List[str]) -> List[List[float]]:
        return [await self.embed_query(t) for t in texts]


_embedding_instance: Optional[EmbeddingModel] = None

def get_embeddings() -> EmbeddingModel:
    global _embedding_instance
    if _embedding_instance is None:
        _embedding_instance = EmbeddingModel()
    return _embedding_instance
