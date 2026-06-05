# syntax=docker/dockerfile:1
# Note: You must download the ollama release (https://github.com/ollama/ollama/releases) 
#       into a file named ollama-linux-amd64.tgz prior to build
#       Build with ` docker build -t ollama-gemma3 . `
#       Run with ` docker run -d --name ollama-gemma3 -p 11434:11434 ollama-gemma3 `
#       Then entrypoint.sh script will automatically pull the gemma3 model for testing
#       Check logs until gemma3 was downloaded  ` docker logs -f ollama-gemma3 `
#       Test ` curl -X POST http://localhost:11434/api/show -H "Content-Type: application/json" -d '{"model":"gemma3"}' `

FROM ubuntu:22.04

# ---- 1. core utilities ------------------------------------------------------
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates tar curl \
 && rm -rf /var/lib/apt/lists/*

# ---- 2. add Ollama release tarball -----------------------------------------
COPY ollama-linux-amd64.tgz /tmp/ollama.tgz

# ---- 3. extract *everything* under /usr/local ------------------------------
RUN tar -xzf /tmp/ollama.tgz -C /usr/local \
 && chmod +x /usr/local/bin/ollama \
 && rm /tmp/ollama.tgz

# shared libs live in /usr/local/lib/ollama
ENV LD_LIBRARY_PATH=/usr/local/lib/ollama:${LD_LIBRARY_PATH:-}

# ---- 4. startup script ------------------------------------------------------
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV OLLAMA_HOST=0.0.0.0:11434
EXPOSE 11434
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
