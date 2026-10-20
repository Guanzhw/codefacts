ARG OFFICIAL_IMAGE
FROM ${OFFICIAL_IMAGE}
COPY dependency-dirs.json /tmp/codefacts-dependency-dirs.json
COPY sanitize.py /tmp/codefacts-sanitize.py
RUN cd / && python3 /tmp/codefacts-sanitize.py && rm /tmp/codefacts-dependency-dirs.json /tmp/codefacts-sanitize.py && git config --system --add safe.directory /testbed
VOLUME ["/testbed/node_modules","/testbed/packages-private/vite-debug/node_modules","/testbed/packages-private/sfc-playground/node_modules","/testbed/packages-private/dts-built-test/node_modules","/testbed/packages-private/dts-test/node_modules","/testbed/packages-private/template-explorer/node_modules","/testbed/packages/runtime-core/node_modules","/testbed/packages/reactivity/node_modules","/testbed/packages/vue-compat/node_modules","/testbed/packages/vue/node_modules","/testbed/packages/compiler-dom/node_modules","/testbed/packages/runtime-test/node_modules","/testbed/packages/runtime-dom/node_modules","/testbed/packages/compiler-sfc/node_modules","/testbed/packages/server-renderer/node_modules","/testbed/packages/compiler-core/node_modules","/testbed/packages/compiler-ssr/node_modules"]
WORKDIR /testbed
ENTRYPOINT []
CMD ["/bin/bash", "--noprofile", "--norc"]
