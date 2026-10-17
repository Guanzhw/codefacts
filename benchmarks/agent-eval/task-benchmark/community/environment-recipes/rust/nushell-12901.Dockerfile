ARG OFFICIAL_IMAGE
FROM ${OFFICIAL_IMAGE}
LABEL org.codefacts.sanitation="nushell-12901 embedded repository and compiled outputs removed; verified third-party Cargo registry/reedline git dependency and Rust toolchain retained"
# Original inventory: selected clean HEAD and 1858 exact source files; /testbed/target=3756088 KiB.
# Preserve Rust 1.77.2 (baseline toolchain), registry279056 KiB and reedline git dependency2476 KiB.
RUN cd / && rm -rf -- /testbed /root/.bashrc && mkdir -p /testbed && git config --system --add safe.directory /testbed
# Frozen sandbox bash -lc needs the already-installed Cargo toolchain on login PATH.
RUN printf '%s\n' 'export PATH="/usr/local/cargo/bin:$PATH"' > /etc/profile.d/codefacts-cargo.sh
WORKDIR /testbed
ENTRYPOINT []
CMD ["/bin/bash", "--noprofile", "--norc"]
