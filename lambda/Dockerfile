ARG MUSL_TAG=aarch64-musl
FROM ghcr.io/rust-cross/rust-musl-cross:${MUSL_TAG}

ARG HOST_TARGET=x86_64-unknown-linux-gnu
RUN CARGO_BUILD_TARGET=$HOST_TARGET cargo install cargo-lambda --locked
