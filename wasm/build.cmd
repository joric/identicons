@echo off
set RUSTFLAGS=-C target-feature=+simd128 -C opt-level=3
wasm-pack build --target web --release
