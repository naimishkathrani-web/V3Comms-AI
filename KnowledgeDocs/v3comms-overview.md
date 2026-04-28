# V3Comms AI - Project Overview

## What is V3Comms AI?
V3Comms AI is an AI-powered communication platform built with Node.js, TypeScript, and Ollama for local LLM inference. It provides a dashboard with chat, translation, and a coding assistant (Builder).

## Architecture
- **Backend**: Express.js server with TypeScript
- **AI Engine**: Ollama for local LLM inference with model fallback chain
- **Frontend**: Vanilla HTML/CSS/JS dashboard
- **Database**: PostgreSQL with pgvector extension for RAG (Retrieval-Augmented Generation)
- **SSH Tunnel**: Connects to remote PostgreSQL via SSH tunnel using ssh2 library

## Key Features
1. **AI Chat**: Multi-model fallback system that tries the fastest model first and falls back to smarter ones
2. **Translation**: Supports multiple languages with streaming responses
3. **Builder**: AI coding assistant that can read/write files, run commands, and verify builds
4. **Knowledge Base**: pgvector-powered RAG system for ingesting and searching documents

## Model Fallback Chain
The system uses a priority-ordered fallback chain:
1. llama3.2:1b (3s timeout) - fastest
2. qwen2.5:1.5b (3s timeout) - good balance
3. tinyllama:latest (2s timeout) - very fast
4. gemma2:2b (3s timeout) - medium
5. phi3.5:latest (4s timeout) - smart
6. mistral:latest (5s timeout) - best quality

If a model doesn't produce a first token within its timeout, the system automatically falls back to the next model in the chain.

## Builder Service
The Builder uses phi3.5:latest as its starting model in the fallback chain. It supports these tools:
- TOOL:read_file - Read file contents
- TOOL:patch_file - Find and replace text in existing files
- TOOL:write_file - Create new files
- TOOL:list_files - List directory contents
- TOOL:run_command - Run shell commands
- TOOL:delete_file - Delete files

## Knowledge Base (pgvector)
The knowledge base uses:
- **Embedding model**: nomic-embed-text (768 dimensions)
- **Schema**: v3knowledge schema in V3CommsAI database
- **Tables**: documents (source tracking) and chunks (text + embeddings)
- **Search**: Cosine similarity search via pgvector

## Configuration
All settings are in .env file:
- Ollama performance tuning (num_ctx, num_predict, temperature, top_k, top_p)
- Model fallback chain with per-model timeouts
- PostgreSQL connection via SSH tunnel
- Builder model selection
- Embedding model selection
