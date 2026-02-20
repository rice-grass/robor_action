from langchain_ollama import OllamaEmbeddings
from typing import List, Optional, Union

from app.config import get_settings

settings = get_settings()


class EmbeddingModel:
    def __init__(
        self,
        model_name: Optional[str] = None,
    ):
        self.model_name = model_name or settings.embedding_model

        # Ollama 임베딩 모델 사용
        self.embeddings = OllamaEmbeddings(
            model=self.model_name,
            base_url=settings.ollama_host
        )

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        """여러 문서를 임베딩"""
        return self.embeddings.embed_documents(texts)

    def embed_query(self, text: str) -> List[float]:
        """쿼리 텍스트 임베딩"""
        return self.embeddings.embed_query(text)

    def get_langchain_embeddings(self) -> OllamaEmbeddings:
        """LangChain 호환 임베딩 객체 반환"""
        return self.embeddings


# 싱글톤 인스턴스
_embedding_instance: Optional[EmbeddingModel] = None


def get_embeddings() -> EmbeddingModel:
    global _embedding_instance
    if _embedding_instance is None:
        _embedding_instance = EmbeddingModel()
    return _embedding_instance
