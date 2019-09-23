FROM jarvus/hologit-actions-base:v1

LABEL version="1.0"
LABEL repository="http://github.com/JarvusInnovations/hologit"
LABEL homepage="http://github.com/JarvusInnovations/hologit"
LABEL maintainer="Chris Alfano <chris@jarv.us>"

LABEL "com.github.actions.name"="Hologit Projector"
LABEL "com.github.actions.description"="Post Slack messages from your own bot"
LABEL "com.github.actions.branding.icon"="sun"
LABEL "com.github.actions.branding.color"="orange"

LABEL "com.github.actions.inputs.holobranch.description"="Name of holobranch to project"
LABEL "com.github.actions.inputs.holobranch.required"="true"
LABEL "com.github.actions.inputs.holobranch.commit-to"="Name of branch/ref to optionally commit result to"

LABEL "com.github.actions.outputs.commit.description"="Commit hash for last projection"

LABEL "com.github.actions.runs.args"="${{ inputs.holobranch }} --commit-to=${{ inputs.commit-to }}"

COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
