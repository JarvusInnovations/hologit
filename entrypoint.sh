#!/bin/bash -e

echo "Projections: $1"

time=$(date)

echo ::set-output "name=time::${time}"
echo ::set-output "name=last-projection::abcdef1234567890"
