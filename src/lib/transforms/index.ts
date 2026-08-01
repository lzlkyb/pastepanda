/**
 * transforms/index.ts — 注册表入口。
 *
 * 导入即注册所有内置变换；UI 从这里拿注册表 API。
 * 新增变换：写一个 Transform 模块 → 在此 registerTransform() → 自动进入枢纽/右键/全屏。
 */

import { registerTransform } from "./registry";
import { sqlInTransform } from "./sqlIn";
import { columnToSqlInTransform } from "./columnSqlIn";
import { delimitedSqlInTransform } from "./delimitedSqlIn";
import { sqlInReverseTransform } from "./sqlInReverse";
import { jsonInsertTransform } from "./jsonInsert";
import { queryResultToSqlTransform } from "./queryResultToSql";
import { textTransforms } from "./textTransforms";
import { configConvertTransforms } from "./configConverts";
import { codecTransforms } from "./codecTransforms";
import { sqlTransforms } from "./sqlTransforms";
import { logTransforms } from "./logTransforms";
import { numberTransforms } from "./numberTransforms";

registerTransform(sqlInTransform);
registerTransform(columnToSqlInTransform);
registerTransform(delimitedSqlInTransform);
registerTransform(sqlInReverseTransform);
registerTransform(jsonInsertTransform);
registerTransform(queryResultToSqlTransform);
textTransforms.forEach(registerTransform);
configConvertTransforms.forEach(registerTransform);
codecTransforms.forEach(registerTransform);
sqlTransforms.forEach(registerTransform);
logTransforms.forEach(registerTransform);
numberTransforms.forEach(registerTransform);

export * from "./types";
export * from "./registry";
export * from "./detectors";
export { analyzeContent } from "./analyzer";
export type { ContentFeatures } from "./analyzer";
export { sqlInTransform } from "./sqlIn";
export { columnToSqlInTransform } from "./columnSqlIn";
export { delimitedSqlInTransform } from "./delimitedSqlIn";
export { jsonInsertTransform, jsonToInsert } from "./jsonInsert";
export type { InsertOptions, InsertResult } from "./jsonInsert";
export { textTransforms } from "./textTransforms";
export { codecTransforms } from "./codecTransforms";
export { sqlTransforms } from "./sqlTransforms";
export { logTransforms } from "./logTransforms";
export { sqlInReverseTransform, extractInValues } from "./sqlInReverse";
export { queryResultToSqlTransform, parseTable, tableToInsert } from "./queryResultToSql";
export { numberTransforms } from "./numberTransforms";
