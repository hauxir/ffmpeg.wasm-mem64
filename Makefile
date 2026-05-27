all: dev

MT_FLAGS := -sUSE_PTHREADS -pthread

DEV_ARGS := --progress=plain

DEV_CFLAGS := --profiling
DEV_MT_CFLAGS := $(DEV_CFLAGS) $(MT_FLAGS)
PROD_CFLAGS := -O3 -msimd128
PROD_MT_CFLAGS := $(PROD_CFLAGS) $(MT_FLAGS)
# memory64 (wasm64) build. SIMD is left off for the lean proof-of-concept to
# keep one fewer variable in play; bump to -O3 -msimd128 once it is stable.
PROD_64_CFLAGS := -O2

# Dockerfile used by the generic `build` target; overridden for memory64.
DOCKERFILE ?= Dockerfile

clean:
	rm -rf ./packages/core$(PKG_SUFFIX)/dist

.PHONY: build
build:
	make clean PKG_SUFFIX="$(PKG_SUFFIX)"
	EXTRA_CFLAGS="$(EXTRA_CFLAGS)" \
	EXTRA_LDFLAGS="$(EXTRA_LDFLAGS)" \
	FFMPEG_ST="$(FFMPEG_ST)" \
	FFMPEG_MT="$(FFMPEG_MT)" \
		docker buildx build \
			-f $(DOCKERFILE) \
			--build-arg EXTRA_CFLAGS \
			--build-arg EXTRA_LDFLAGS \
			--build-arg FFMPEG_MT \
			--build-arg FFMPEG_ST \
			-o ./packages/core$(PKG_SUFFIX) \
			$(EXTRA_ARGS) \
			.

build-st:
	make build \
		FFMPEG_ST=yes

build-mt:
	make build \
		PKG_SUFFIX=-mt \
		FFMPEG_MT=yes

build-64:
	make build \
		PKG_SUFFIX=-64 \
		DOCKERFILE=Dockerfile.mem64 \
		FFMPEG_ST=yes

dev:
	make build-st EXTRA_CFLAGS="$(DEV_CFLAGS)" EXTRA_ARGS="$(DEV_ARGS)"

dev-mt:
	make build-mt EXTRA_CFLAGS="$(DEV_MT_CFLAGS)" EXTRA_ARGS="$(DEV_ARGS)"

prd:
	make build-st EXTRA_CFLAGS="$(PROD_CFLAGS)"

prd-mt:
	make build-mt EXTRA_CFLAGS="$(PROD_MT_CFLAGS)"

# memory64 (wasm64) single-thread production build -> packages/core-64
prd-64:
	make build-64 EXTRA_CFLAGS="$(PROD_64_CFLAGS)"

dev-64:
	make build-64 EXTRA_CFLAGS="$(PROD_64_CFLAGS) --profiling" EXTRA_ARGS="$(DEV_ARGS)"

# Verify the built wasm64 core: confirms 64-bit memory and runs real ffmpeg
# commands. Uses a Node whose V8 is new enough for finalized Memory64 (64-bit
# tables), which most host/emsdk Nodes are not -> run it in node:24.
verify-64:
	docker buildx build -f Dockerfile.verify64 -t ffmpeg-mem64-verify --load .
	docker run --rm ffmpeg-mem64-verify
