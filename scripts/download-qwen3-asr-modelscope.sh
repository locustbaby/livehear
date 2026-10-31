#!/bin/sh
set -eu

model_dir="${1:-${HOME}/Library/Caches/livehear/models/qwen3-asr-1.7b}"
base_url='https://www.modelscope.cn/models/ggml-org/Qwen3-ASR-1.7B-GGUF/resolve/master'
mkdir -p "$model_dir"
for name in Qwen3-ASR-1.7B-Q8_0.gguf mmproj-Qwen3-ASR-1.7B-Q8_0.gguf; do
  curl --fail --location --retry 3 --continue-at - --output "$model_dir/$name" "$base_url/$name"
done
printf '%s  %s\n' \
  '58e22d0532d4eacaf034cfac17a6fed159f37c41390c710186783be439d1fc57' "$model_dir/Qwen3-ASR-1.7B-Q8_0.gguf" \
  '46c1d533af3f354ceb37ce855dbceff7da7fa7cf1e6a523df3b13440bd164c0d' "$model_dir/mmproj-Qwen3-ASR-1.7B-Q8_0.gguf" | shasum -a 256 -c
