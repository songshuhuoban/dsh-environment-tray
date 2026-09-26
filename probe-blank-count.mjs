/**
 * 探针：算清空行到底有几个。
 *
 * 我在这个断言上连续错了三次（每次都靠猜），这次把计数逐项打出来。
 *
 * 运行：node probe-blank-count.mjs
 */

const seedText = ['# 这是用户自己的注释', 'ALPHA=1', '', '# 分组标题', 'BETA=2', 'GAMMA="three"', ''].join('\n')

const afterWrite = seedText.replace('BETA=2', 'BETA="changed"')

console.log('seed text      :', JSON.stringify(seedText))
console.log('after write    :', JSON.stringify(afterWrite))
console.log()
console.log('seed  "\\n\\n" count      :', (seedText.match(/\n\n/g) ?? []).length)
console.log('after "\\n\\n" count      :', (afterWrite.match(/\n\n/g) ?? []).length)
console.log()
console.log('seed  split("\\n") empties:', seedText.split('\n').filter((l) => l === '').length)
console.log('after split("\\n") empties:', afterWrite.split('\n').filter((l) => l === '').length)
console.log()
console.log('seed  total lines        :', JSON.stringify(seedText.split('\n')))
console.log('after total lines        :', JSON.stringify(afterWrite.split('\n')))
console.log()
console.log('identical after replace  :', seedText.replace('BETA=2', 'BETA="changed"') === afterWrite)
