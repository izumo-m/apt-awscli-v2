ARG MUSL_TAG=aarch64-musl
FROM ghcr.io/rust-cross/rust-musl-cross:${MUSL_TAG}

ARG HOST_TARGET=x86_64-unknown-linux-gnu
ARG MUSL_TARGET=aarch64-unknown-linux-musl
RUN rustup toolchain uninstall stable \
 && rustup toolchain install stable --profile minimal \
     --target "$HOST_TARGET" --target "$MUSL_TARGET" \
 && rustup default stable

RUN CARGO_BUILD_TARGET=$HOST_TARGET cargo install cargo-lambda --locked
