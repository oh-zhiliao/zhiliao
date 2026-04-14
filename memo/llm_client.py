import numpy as np
from openai import AsyncOpenAI


class LLMClient:
    def __init__(
        self,
        llm_base_url: str,
        llm_model: str,
        llm_api_key: str,
        embedding_base_url: str,
        embedding_model: str,
    ):
        self._llm_client = AsyncOpenAI(base_url=llm_base_url, api_key=llm_api_key)
        self._llm_model = llm_model
        self._embed_client = AsyncOpenAI(base_url=embedding_base_url, api_key=llm_api_key)
        self._embed_model = embedding_model

    async def summarize(self, prompt: str, max_tokens: int = 512) -> str:
        response = await self._llm_client.chat.completions.create(
            model=self._llm_model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=max_tokens,
            temperature=0.3,
        )
        return response.choices[0].message.content or ""

    async def embed(self, text: str) -> np.ndarray:
        response = await self._embed_client.embeddings.create(
            model=self._embed_model,
            input=text,
        )
        return np.array(response.data[0].embedding, dtype=np.float32)

    async def embed_batch(self, texts: list[str]) -> list[np.ndarray]:
        response = await self._embed_client.embeddings.create(
            model=self._embed_model,
            input=texts,
        )
        return [np.array(d.embedding, dtype=np.float32) for d in sorted(response.data, key=lambda d: d.index)]
