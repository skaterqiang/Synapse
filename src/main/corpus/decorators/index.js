// 语料流水线·装饰器汇总导出（设计 §9.1 decorators/index.js）
// 一处 require 拿到全部内置层，供 build.js 的 LAYERS 注册表与测试使用。
'use strict';

const { ParseLayer, MineruDecorator, SkillMarkdownDecorator, BuiltinParseDecorator, CorpusReuseDecorator, FallbackDecorator, BUILTIN_EXTS, SCRIPT_MD_NAME } = require('./parse');
const { CacheDecorator } = require('./cache');
const { FilterDecorator } = require('./filter');
const { CorpusWriteDecorator } = require('./corpusWrite');
const { ChunkDecorator, TruncateDecorator, LimitDecorator, splitText } = require('./chunk');
const { EnrichDecorator } = require('./enrich');
const { ExtractDecorator } = require('./extract');
const { GuardDecorator } = require('./guard');
const { GraphMergeDecorator } = require('./mergeGraph');
const { NoteImportDecorator } = require('./noteImport');
const { LogDecorator, TeeDecorator, NullSink, CapsDecorator, LLM_CALL_HINT_AT } = require('./log');

module.exports = {
  // 解析类（§4.2）
  ParseLayer, MineruDecorator, SkillMarkdownDecorator, BuiltinParseDecorator, FallbackDecorator,
  CorpusReuseDecorator, // 可选层（§4.2 / O4），默认不在配方中
  BUILTIN_EXTS, SCRIPT_MD_NAME,
  // 加工类（§4.3）
  CacheDecorator, FilterDecorator, CorpusWriteDecorator,
  ChunkDecorator, TruncateDecorator, LimitDecorator, splitText,
  EnrichDecorator, ExtractDecorator, GuardDecorator, GraphMergeDecorator, NoteImportDecorator,
  // 辅助层
  LogDecorator, TeeDecorator, NullSink, CapsDecorator, LLM_CALL_HINT_AT,
};
