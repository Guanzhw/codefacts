# Actual offline build: exact local immutable image; reviewed sanitation instructions.
ARG OFFICIAL_IMAGE
FROM ${OFFICIAL_IMAGE}
LABEL org.codefacts.source-manifest="sha256:924c1bac3251b62b23a0db0692f7ed0759b1397e164982eedf12096a11393927"
LABEL org.codefacts.source-config="sha256:0983ece7324e9c339264a15748f88231f1bdf0e8b6e56a441021c01b38de7b18"
LABEL org.codefacts.sanitation="retain offline dependencies only; remove embedded repository and startup/install logs"
# Inventory: node_modules is 250 MiB, with 89 internal symlinks, no nested axios package.
# Keep dependency files in their normal path for Docker anonymous-volume population.
RUN cd / && find /testbed -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf -- {} + \
    && rm -rf -- /root/.npm/_logs /root/.bashrc \
    && git config --system --add safe.directory /testbed
VOLUME ["/testbed/node_modules"]
WORKDIR /testbed
ENTRYPOINT []
CMD ["/bin/bash", "--noprofile", "--norc"]
