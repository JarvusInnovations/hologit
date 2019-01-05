# Making a new release

1. Bump version number in `package.json`
1. Merge into `master` and tag release version
1. On `master`, run `npm publish --dry-run` to verify files/version and then run `npm publish`
1. Promote `hologit` and `hologit-studio` builds to stable on bldr.habitat.sh after autobuilds finished
1. Build docker container with `sudo hab pkg export docker jarvus/hologit-studio`
1. Push docker container with `docker push jarvus/hologit-studio:latest`
