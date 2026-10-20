ARG OFFICIAL_IMAGE
FROM ${OFFICIAL_IMAGE}
LABEL org.codefacts.source-manifest="sha256:f1559c2f158f4f967531a1b57ed2a845c40a3d8ddb820b9e5bd56947c096d244"
LABEL org.codefacts.source-config="sha256:b9669f9d8e5d3cc152f7b3aa4c8fba581135b09056e30d7d3fc8e9100cb2c84f"
LABEL org.codefacts.sanitation="remove embedded repository, compiled task cache, upstream root startup script"
# Inventory found /testbed/.git, /testbed/integration.test and a populated Go build cache.
# Preserve Go compiler and downloaded dependency module cache for offline compilation.
RUN cd / && rm -rf -- /testbed /root/.cache/go-build /root/.bashrc && mkdir -p /testbed /root/.cache/go-build && git config --system --add safe.directory /testbed
WORKDIR /testbed
ENTRYPOINT []
CMD ["/bin/bash", "--noprofile", "--norc"]
