FROM ubuntu:24.04

ARG BUILD_ARG_TEST
RUN echo -n "${BUILD_ARG_TEST}" > /tmp/build-arg-check

COPY /context-marker.txt /tmp/context-marker.txt
