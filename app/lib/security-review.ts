export type SecurityIssue = "weak_password" | "reused_password" | "missing_two_factor";

type ReviewableCredential = {
  id: string;
  password: string;
  strength: "安全" | "一般" | "风险";
  twoFactor: boolean;
};

export function reviewCredentialSecurity(items: ReviewableCredential[]) {
  const passwordUseCount = new Map<string, number>();
  for (const item of items) {
    passwordUseCount.set(item.password, (passwordUseCount.get(item.password) ?? 0) + 1);
  }

  return new Map(items.map((item) => {
    const issues: SecurityIssue[] = [];
    // “一般”代表长度未达到推荐的 14 位，因此也应在安全检查中给出可处理的提醒。
    if (item.strength !== "安全") issues.push("weak_password");
    if ((passwordUseCount.get(item.password) ?? 0) > 1) issues.push("reused_password");
    if (!item.twoFactor) issues.push("missing_two_factor");
    return [item.id, issues] as const;
  }));
}
