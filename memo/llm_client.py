import asyncio

import httpx
import numpy as np
import openai
from openai import AsyncOpenAI


class LLMClient:
    def __init__(
        self,
        llm_base_url: str,
        llm_model: str,
        llm_api_key: str,
        embedding_base_url: str,
        embedding_model: str,
        embedding_api_key: str = "",
        timeout: float = 60.0,
    ):
        timeout = httpx.Timeout(timeout, connect=10.0)
        self._llm_client = AsyncOpenAI(base_url=llm_base_url, api_key=llm_api_key, timeout=timeout)
        self._llm_model = llm_model
        self._embed_client = AsyncOpenAI(
            base_url=embedding_base_url,
            api_key=embedding_api_key or llm_api_key,
            timeout=timeout,
        )
        self._embed_model = embedding_model

    async def _retry_call(self, fn, *args, **kwargs):
        max_retries = 3
        for attempt in range(max_retries):
            try:
                return await fn(*args, **kwargs)
            except (openai.APITimeoutError, openai.APIConnectionError):
                if attempt == max_retries - 1:
                    raise
                await asyncio.sleep(2 ** attempt)
            except openai.APIStatusError as e:
                if e.status_code in (429,) or e.status_code >= 500:
                    if attempt == max_retries - 1:
                        raise
                    await asyncio.sleep(2 ** attempt)
                else:
                    raise

    async def summarize(self, prompt: str, max_tokens: int = 512) -> str:
        response = await self._retry_call(
            self._llm_client.chat.completions.create,
            model=self._llm_model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=max_tokens,
            temperature=0.3,
        )
        return response.choices[0].message.content or ""

    async def embed(self, text: str) -> np.ndarray:
        response = await self._retry_call(
            self._embed_client.embeddings.create,
            model=self._embed_model,
            input=text,
        )
        return np.array(response.data[0].embedding, dtype=np.float32)

    async def embed_batch(self, texts: list[str]) -> list[np.ndarray]:
        if not texts:
            return []
        response = await self._retry_call(
            self._embed_client.embeddings.create,
            model=self._embed_model,
            input=texts,
        )
        return [np.array(d.embedding, dtype=np.float32) for d in sorted(response.data, key=lambda d: d.index)]
