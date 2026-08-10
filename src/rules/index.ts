import { dependencyAddedRule } from "./dependency-added.js";
import { largeChangeRule } from "./large-change.js";
import { placeholderAddedRule } from "./placeholder-added.js";
import { secretAddedRule } from "./secret-added.js";
import { sensitiveFileChangedRule } from "./sensitive-file-changed.js";
import { scopeViolationRule } from "./scope-violation.js";
import { testDisabledRule } from "./test-disabled.js";
import type { Rule } from "../types.js";

export const rules: Rule[] = [
  secretAddedRule,
  testDisabledRule,
  placeholderAddedRule,
  dependencyAddedRule,
  sensitiveFileChangedRule,
  scopeViolationRule,
  largeChangeRule,
];
