# NeMo Canary Transcription Backend
# ==================================
# Requires NVIDIA GPU with CUDA 12.x for production use.
# Falls back to CPU if no GPU is available (slower).
#
# Build:
#   docker build -t canary-backend -f backend/Dockerfile .
#
# Run:
#   docker run --gpus all -p 8000:8000 \
#     -e CANARY_PRELOAD=1 \
#     -e CORS_ORIGINS="http://localhost:4321" \
#     canary-backend

FROM nvidia/cuda:12.4.0-runtime-ubuntu22.04

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 \
    python3-pip \
    python3.11-venv \
    ffmpeg \
    libsndfile1 \
    libsndfile1-dev \
    git \
    && rm -rf /var/lib/apt/lists/*

# Create symlinks for convenience
RUN ln -sf /usr/bin/python3.11 /usr/bin/python && \
    ln -sf /usr/bin/pip3 /usr/bin/pip

WORKDIR /app

# Install Python dependencies
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY backend/main.py .

# Pre-download the model at build time (optional, saves startup time)
# Uncomment if you want the model baked into the image:
# RUN python -c "from nemo.collections.asr.models import EncDecMultiTaskModel; \
#     EncDecMultiTaskModel.from_pretrained('nvidia/canary-180m-flash')"

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

# Start server
CMD ["python", "main.py"]
