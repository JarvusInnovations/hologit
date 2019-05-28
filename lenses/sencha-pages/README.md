# sencha-pages lens

## Debug form of script

```bash
  sencha \
    --sdk-path='./ext' \
    compile \
      --classpath='./ext/packages/core/src' \
      --classpath='./ext/packages/core/overrides' \
      --classpath='./pages/src' \
      union --recursive --tag='class' \
      and save core \
      and concat \
        --input-js-version='ANY' \
        --js-version='ANY' \
        --strip-comments \
        --output-file='./build/common.js' \
      and metadata \
        --filenames \
        --tpl='{0}' \
        --output-file='./classes-core.txt' \
      and union --recursive --include-uses=no --tag='core' \
      and require --source-name='Ext.event.publisher.Dom' --requires='Ext.GlobalEvents' \
      and include --recursive --include-uses=no --class='Site.Common' \
      and exclude --set='core' \
      and metadata \
        --filenames \
        --tpl='{0}' \
        --output-file='./classes-common.txt' \
      and concat \
        --input-js-version='ANY' \
        --js-version='ANY' \
        --strip-comments \
        --append \
        --output-file='./build/common.js'
```