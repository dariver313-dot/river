export type VaultSpace = "个人" | "公共";

// 小型团队产品的硬上限：避免单次全量解密、导出或安全检查被异常数据量拖垮。
export const vaultItemLimitBySpace: Record<VaultSpace, number> = {
  个人: 500,
  公共: 1_000,
};

export function vaultItemLimit(space: VaultSpace) {
  return vaultItemLimitBySpace[space];
}

const fieldLimits = {
  name: 120,
  domain: 255,
  username: 255,
  password: 1024,
  category: 60,
  totpLabel: 40,
  brand: 32,
  note: 1_000,
} as const;

export function isVaultSpace(value: unknown): value is VaultSpace {
  return value === "个人" || value === "公共";
}

export function boundedText(value: unknown, field: keyof typeof fieldLimits, options: { trim?: boolean; required?: boolean } = {}) {
  const text = typeof value === "string" ? (options.trim === false ? value : value.trim()) : "";
  if (options.required && !text) throw new Error(`${fieldLabel(field)}不能为空。`);
  if (text.length > fieldLimits[field]) throw new Error(`${fieldLabel(field)}不能超过 ${fieldLimits[field]} 个字符。`);
  return text;
}

export function assertVaultMoveAllowed(currentSpace: VaultSpace, nextSpace: VaultSpace, isAdmin: boolean) {
  if (currentSpace === "公共" && nextSpace !== "公共") {
    throw new Error("公共项目不能移入个人项目。若不再需要公开，请删除或归档。");
  }
  if (currentSpace === "个人" && nextSpace === "公共" && !isAdmin) {
    throw new Error("只有管理员可以将个人项目设为公共项目。");
  }
}

function fieldLabel(field: keyof typeof fieldLimits) {
  const labels: Record<keyof typeof fieldLimits, string> = {
    name: "名称",
    domain: "网址",
    username: "用户名",
    password: "密码",
    category: "分类",
    totpLabel: "验证器用途名称",
    brand: "标识",
    note: "备注",
  };
  return labels[field];
}
