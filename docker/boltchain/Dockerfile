# Boltchain 節點（Luphia/boltchain），給 docker-compose.yml 的 `boltchain` 服務用。
#
# 原始碼兩種來源（BOLTCHAIN_SOURCE）：
#   git    預設。從 BOLTCHAIN_GIT 的 BOLTCHAIN_REF 抓（分支、tag 或 commit）
#   local  用本機已經 clone 好的 boltchain：compose 把 BOLTCHAIN_SRC 當作名為 boltchain-local 的 build context
#          （bootstrap.sh 看到 BOLTCHAIN_SRC 會自動切到 local）
#
# 第一次編譯要十幾分鐘到半小時（RandomX、libmdbx、整條 EVM）。cargo 的下載與編譯產物放在 BuildKit 的快取裡，
# 換 commit 重編只重編改到的 crate。

ARG BOLTCHAIN_SOURCE=git
ARG RUST_IMAGE=rust:1.95-bookworm

# ── 原始碼 ─────────────────────────────────────────────────────────
FROM ${RUST_IMAGE} AS src-git
ARG BOLTCHAIN_GIT=https://github.com/Luphia/boltchain.git
ARG BOLTCHAIN_REF=main
# 只抓需要的歷史：分支／tag 用淺 clone；給的是 commit 就退回完整 clone 再 checkout
RUN git clone --depth 1 --branch "$BOLTCHAIN_REF" "$BOLTCHAIN_GIT" /src 2>/dev/null \
 || { git clone "$BOLTCHAIN_GIT" /src && git -C /src checkout "$BOLTCHAIN_REF"; }

FROM scratch AS src-local
COPY --from=boltchain-local . /src

FROM src-${BOLTCHAIN_SOURCE} AS src

# ── 編譯 ───────────────────────────────────────────────────────────
FROM ${RUST_IMAGE} AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends cmake clang libclang-dev \
 && rm -rf /var/lib/apt/lists/*
COPY --from=src /src /src
WORKDIR /src
# 本機 clone 可能帶著 target/（幾 GB、而且是別的平台編的）；不要讓它混進來
RUN rm -rf target
# rust-toolchain.toml 指定 channel 1.95 ＋ rustfmt/clippy；編譯不需要那兩個元件，
# 直接用映像檔裡的工具鏈，省掉 rustup 在建置時再下載一次。
RUN --mount=type=cache,id=boltchain-cargo,target=/usr/local/cargo/registry \
    --mount=type=cache,id=boltchain-target,target=/src/target \
    RUSTUP_TOOLCHAIN="$RUST_VERSION" cargo build --release --locked -p boltchain \
 && cp target/release/boltchain /usr/local/bin/boltchain \
 && /usr/local/bin/boltchain --version

# ── 執行 ───────────────────────────────────────────────────────────
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/boltchain /usr/local/bin/boltchain
COPY genesis.json /etc/boltchain/genesis.json
COPY entrypoint.sh /usr/local/bin/boltchain-entrypoint
RUN chmod 755 /usr/local/bin/boltchain-entrypoint \
 && boltchain genesis inspect /etc/boltchain/genesis.json
VOLUME /data
EXPOSE 8545 9017
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/boltchain-entrypoint"]
