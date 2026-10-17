ARG OFFICIAL_IMAGE
FROM ${OFFICIAL_IMAGE}
LABEL org.codefacts.source-manifest="sha256:27efcf350038653acd2c7e23f9d0f8d69ef4e2a01ad3ee45f7cd6faa3adf0018"
# Actual original inventory: embedded upstream repository, integration.test,
# task compilation cache, and a missing Conda path in the root startup file.
RUN cd / && rm -rf -- /testbed /root/.cache/go-build /root/.bashrc && mkdir -p /testbed /root/.cache/go-build && git config --system --add safe.directory /testbed
WORKDIR /testbed
ENTRYPOINT []
CMD ["/bin/bash", "--noprofile", "--norc"]
