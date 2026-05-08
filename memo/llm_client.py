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
        llm_provider: str = "openai_compatible",
    ):
        timeout = httpx.Timeout(timeout, connect=10.0)
        self._llm_base_url = llm_base_url.rstrip("/")
        self._llm_provider = llm_provider
        self._llm_api_key = llm_api_key
        self._http_client = httpx.AsyncClient(timeout=timeout)
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

    async def _retry_http_call(self, fn, *args, **kwargs):
        max_retries = 3
        for attempt in range(max_retries):
            try:
                response = await fn(*args, **kwargs)
                response.raise_for_status()
                return response
            except (httpx.TimeoutException, httpx.TransportError, httpx.HTTPStatusError) as e:
                status_code = e.response.status_code if isinstance(e, httpx.HTTPStatusError) else None
                retryable = status_code is None or status_code == 429 or status_code >= 500
                if not retryable or attempt == max_retries - 1:
                    raise
                await asyncio.sleep(2 ** attempt)

    async def summarize(self, prompt: str, max_tokens: int = 512) -> str:
        if self._llm_provider == "anthropic":
            response = await self._retry_http_call(
                self._http_client.post,
                f"{self._llm_base_url}/v1/messages",
                headers={
                    "Authorization": f"Bearer {self._llm_api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self._llm_model,
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": max_tokens,
                },
            )
            data = response.json()
            return "".join(
                block.get("text", "")
                for block in data.get("content", [])
                if block.get("type") == "text"
            )

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
