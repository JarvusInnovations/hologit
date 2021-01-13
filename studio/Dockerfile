# common base for both stages
FROM habitat/default-studio-x86_64-linux:0.79.0 as base

ARG HAB_LICENSE=no-accept
ENV HAB_LICENSE=$HAB_LICENSE
ENV HAB_ORIGIN=jarvus

ENTRYPOINT ["hab", "sup", "run"]
CMD ["jarvus/hologit-studio"]

RUN hab pkg install \
        core/hab-sup/0.79.0 \
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

ARG HOLOGIT_STUDIO_PACKAGE=jarvus/hologit-studio
RUN hab pkg install $HOLOGIT_STUDIO_PACKAGE \
    && hab pkg exec core/coreutils rm -rf /hab/cache/{artifacts,src}/
