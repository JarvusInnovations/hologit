# common base for both stages
FROM habitat/default-studio-x86_64-linux:0.79.1 as base

ARG HAB_LICENSE=no-accept
ENV HAB_LICENSE=$HAB_LICENSE
ENV HAB_ORIGIN=jarvus
RUN hab origin key generate


# intermediary stage used to build hologit-studio package
FROM base as builder

RUN hab pkg install core/hab-plan-build/0.79.1
COPY . /src
RUN hab pkg exec core/hab-plan-build hab-plan-build /src


# final stage to be published
FROM base as studio

ENTRYPOINT ["hab", "sup", "run"]
CMD ["jarvus/hologit-studio"]

COPY --from=builder /hab/cache/artifacts /hab/cache/artifacts
RUN hab pkg install \
        /hab/cache/artifacts/$HAB_ORIGIN-hologit-studio-* \
        core/hab-sup/0.79.1 \
        core/hab-launcher/10180 \
        core/tar \
        core/gcc \
    && hab pkg exec core/coreutils rm -rf /hab/cache/{artifacts,src}/

RUN hab pkg binlink core/busybox-static \
    && hab pkg binlink --dest /usr/bin core/busybox-static env \
    && hab pkg binlink --force core/tar

RUN mkdir -m 1777 -p /tmp \
    && mkdir -m 0750 -p /root \
    && mkdir -m 0755 -p /usr/bin /home \
    && addgroup developer \
    && chgrp -R developer /hab \
    && chmod -R g+w /hab
