"use client";

import {
  AlertTriangle,
  Archive,
  ArrowUpRight,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Clock3,
  Copy,
  CreditCard,
  Edit3,
  Eye,
  EyeOff,
  FileKey2,
  Folder,
  Globe2,
  Heart,
  KeyRound,
  LockKeyhole,
  LogOut,
  Menu,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  ShieldEllipsis,
  Smartphone,
  Star,
  UserRound,
  UsersRound,
  WandSparkles,
  X,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";

type Strength = "安全" | "一般" | "风险";
type ItemType = "登录" | "卡片" | "安全笔记";

type VaultItem = {
  id: number;
  name: string;
  domain: string;
  username: string;
  password: string;
  type: ItemType;
  group: string;
  updated: string;
  strength: Strength;
  twoFactor: boolean;
  favorite: boolean;
  brand: string;
  note: string;
};

const seedItems: VaultItem[] = [
  {
    id: 1,
    name: "Figma",
    domain: "figma.com",
    username: "lin.chen@studio.cn",
    password: "K7!mP2#qL9@vX4",
    type: "登录",
    group: "工作",
    updated: "刚刚更新",
    strength: "安全",
    twoFactor: true,
    favorite: true,
    brand: "figma",
    note: "设计团队工作区 · 已绑定安全密钥",
  },
  {
    id: 2,
    name: "GitHub",
    domain: "github.com",
    username: "chenlin-dev",
    password: "dV8$kR5!yN2@wQ",
    type: "登录",
    group: "开发",
    updated: "2 小时前",
    strength: "安全",
    twoFactor: true,
    favorite: true,
    brand: "github",
    note: "个人开发账号 · 恢复码已归档",
  },
  {
    id: 3,
    name: "企业邮箱",
    domain: "mail.work.cn",
    username: "chen.lin@work.cn",
    password: "Spring2024!",
    type: "登录",
    group: "工作",
    updated: "昨天",
    strength: "风险",
    twoFactor: false,
    favorite: false,
    brand: "mail",
    note: "检测到重复密码，建议立即更新",
  },
  {
    id: 4,
    name: "Notion",
    domain: "notion.so",
    username: "lin.chen@studio.cn",
    password: "N8#xF4@qT6!sL2",
    type: "登录",
    group: "工作",
    updated: "3 天前",
    strength: "安全",
    twoFactor: true,
    favorite: false,
    brand: "notion",
    note: "团队知识库",
  },
  {
    id: 5,
    name: "招商银行 Visa",
    domain: "尾号 2048",
    username: "陈林",
    password: "482",
    type: "卡片",
    group: "财务",
    updated: "6 天前",
    strength: "安全",
    twoFactor: false,
    favorite: false,
    brand: "card",
    note: "有效期 08/29 · 仅作演示数据",
  },
  {
    id: 6,
    name: "家庭 Wi-Fi",
    domain: "Home-5G",
    username: "admin",
    password: "Home#2022wifi",
    type: "安全笔记",
    group: "家庭",
    updated: "2 周前",
    strength: "一般",
    twoFactor: false,
    favorite: false,
    brand: "wifi",
    note: "客厅路由器，建议本月轮换密码",
  },
];

const filters = ["全部", "登录", "卡片", "安全笔记"] as const;

function BrandMark({ item }: { item: VaultItem }) {
  const initials = item.name.slice(0, 1).toUpperCase();
  return (
    <span className={`brand-mark brand-${item.brand}`} aria-hidden="true">
      {item.type === "卡片" ? <CreditCard size={19} /> : item.type === "安全笔记" ? <FileKey2 size={19} /> : initials}
    </span>
  );
}

function StrengthBadge({ strength }: { strength: Strength }) {
  const Icon = strength === "风险" ? AlertTriangle : strength === "一般" ? Clock3 : ShieldCheck;
  return (
    <span className={`strength strength-${strength}`}>
      <Icon size={14} aria-hidden="true" />
      {strength}
    </span>
  );
}

export default function Home() {
  const [items, setItems] = useState(seedItems);
  const [selectedId, setSelectedId] = useState(1);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof filters)[number]>("全部");
  const [revealed, setRevealed] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [locked, setLocked] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [toast, setToast] = useState("");
  const [form, setForm] = useState({ name: "", domain: "", username: "", password: "", group: "个人" });

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return items.filter((item) => {
      const matchesFilter = filter === "全部" || item.type === filter;
      const matchesQuery = !normalized || [item.name, item.domain, item.username, item.group].some((value) => value.toLowerCase().includes(normalized));
      return matchesFilter && matchesQuery;
    });
  }, [filter, items, query]);

  const selected = items.find((item) => item.id === selectedId) ?? items[0];

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowAdd(false);
        setMobileNav(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);

  async function copyValue(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setToast(`${label}已复制，30 秒后请清理剪贴板`);
    } catch {
      setToast("复制失败，请手动选择内容");
    }
  }

  function toggleFavorite(id: number) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, favorite: !item.favorite } : item)));
  }

  function submitCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next: VaultItem = {
      id: Date.now(),
      name: form.name.trim(),
      domain: form.domain.trim().replace(/^https?:\/\//, ""),
      username: form.username.trim(),
      password: form.password,
      type: "登录",
      group: form.group,
      updated: "刚刚添加",
      strength: form.password.length >= 14 ? "安全" : form.password.length >= 10 ? "一般" : "风险",
      twoFactor: false,
      favorite: false,
      brand: "new",
      note: "演示版本：此项目仅保留在当前会话",
    };
    setItems((current) => [next, ...current]);
    setSelectedId(next.id);
    setForm({ name: "", domain: "", username: "", password: "", group: "个人" });
    setShowAdd(false);
    setToast("登录项已加入当前演示会话");
  }

  function generatePassword() {
    setForm((current) => ({ ...current, password: "V9@rK4!mT7#qL2xP" }));
    setToast("已生成 16 位演示密码");
  }

  return (
    <div className="vault-app">
      <a className="skip-link" href="#main-content">跳到主要内容</a>

      <div className={`sidebar-backdrop ${mobileNav ? "is-visible" : ""}`} onClick={() => setMobileNav(false)} aria-hidden="true" />
      <aside className={`sidebar ${mobileNav ? "is-open" : ""}`} aria-label="主导航">
        <div className="brand-lockup">
          <span className="brand-icon" aria-hidden="true"><ShieldCheck size={22} strokeWidth={2.2} /></span>
          <div><strong>守钥</strong><span>个人安全中心</span></div>
          <button className="icon-button sidebar-close" onClick={() => setMobileNav(false)} aria-label="关闭导航"><X size={20} /></button>
        </div>

        <nav className="main-nav">
          <p className="nav-label">密码库</p>
          <button className="nav-item is-active"><KeyRound size={18} /><span>所有项目</span><span className="nav-count">{items.length}</span></button>
          <button className="nav-item"><Star size={18} /><span>收藏</span><span className="nav-count">{items.filter((item) => item.favorite).length}</span></button>
          <button className="nav-item"><ShieldEllipsis size={18} /><span>安全检查</span><span className="nav-alert">3</span></button>
          <button className="nav-item"><Archive size={18} /><span>归档</span></button>

          <p className="nav-label nav-label-spaced">空间</p>
          <button className="nav-item"><UserRound size={18} /><span>个人</span></button>
          <button className="nav-item"><UsersRound size={18} /><span>家庭共享</span></button>
          <button className="nav-item"><Building2 size={18} /><span>Studio 团队</span></button>
        </nav>

        <div className="sidebar-tip">
          <ShieldCheck size={18} aria-hidden="true" />
          <div><strong>本地会话已加锁</strong><span>演示数据不会写入浏览器存储</span></div>
        </div>

        <div className="account-menu">
          <span className="avatar" aria-hidden="true">陈</span>
          <div><strong>陈林</strong><span>个人计划</span></div>
          <button className="icon-button dark-icon" aria-label="账号设置"><MoreHorizontal size={19} /></button>
        </div>
      </aside>

      <main id="main-content" className="main-shell">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="打开导航"><Menu size={21} /></button>
          <div className="page-title"><h1>密码库</h1><p>集中管理登录信息、卡片与安全笔记</p></div>
          <div className="topbar-search">
            <Search size={18} aria-hidden="true" />
            <label className="sr-only" htmlFor="vault-search">搜索密码库</label>
            <input id="vault-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索账号、网址或分类" />
            <kbd>⌘ K</kbd>
          </div>
          <button className="secondary-button lock-button" onClick={() => setLocked(true)}><LockKeyhole size={17} />锁定</button>
          <button className="primary-button" onClick={() => setShowAdd(true)}><Plus size={18} />新建项目</button>
        </header>

        <section className="security-strip" aria-labelledby="security-heading">
          <div className="score-block">
            <div className="score-copy"><span>安全评分</span><strong id="security-heading">86<small>/100</small></strong></div>
            <div className="score-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={86} aria-label="安全评分 86 分"><span /></div>
            <p><Check size={15} aria-hidden="true" />整体状况良好</p>
          </div>
          <button className="risk-item"><span className="risk-icon risk-danger"><AlertTriangle size={17} /></span><span><strong>1 个重复密码</strong><small>建议立即更换</small></span><ChevronRight size={18} /></button>
          <button className="risk-item"><span className="risk-icon risk-warning"><Clock3 size={17} /></span><span><strong>2 个长期未更新</strong><small>超过 12 个月</small></span><ChevronRight size={18} /></button>
          <button className="risk-item"><span className="risk-icon risk-info"><Smartphone size={17} /></span><span><strong>3 个未启用双重验证</strong><small>提升账号防护</small></span><ChevronRight size={18} /></button>
        </section>

        <div className="content-grid">
          <section className="vault-panel" aria-labelledby="vault-list-title">
            <div className="panel-toolbar">
              <div className="filter-tabs" role="group" aria-label="项目类型筛选">
                {filters.map((item) => (
                  <button key={item} className={filter === item ? "is-selected" : ""} onClick={() => setFilter(item)}>{item}{item === "全部" && <span>{items.length}</span>}</button>
                ))}
              </div>
              <button className="sort-button">最近更新<ChevronDown size={16} /></button>
            </div>

            <div className="list-heading">
              <div><h2 id="vault-list-title">{filter === "全部" ? "全部项目" : filter}</h2><span>{visibleItems.length} 项</span></div>
              <span>安全状态</span><span>更新时间</span><span className="sr-only">更多操作</span>
            </div>

            <div className="vault-list">
              {visibleItems.length > 0 ? visibleItems.map((item) => (
                <button key={item.id} className={`vault-row ${selectedId === item.id ? "is-selected" : ""}`} onClick={() => { setSelectedId(item.id); setRevealed(false); }} aria-pressed={selectedId === item.id}>
                  <div className="item-identity"><BrandMark item={item} /><span><strong>{item.name}</strong><small>{item.username}</small></span></div>
                  <div><StrengthBadge strength={item.strength} /></div>
                  <span className="updated-at">{item.updated}</span>
                  <span className="row-chevron"><ChevronRight size={18} /></span>
                </button>
              )) : (
                <div className="empty-state"><Search size={24} /><h3>没有找到匹配项目</h3><p>尝试搜索其他账号、网址或分类。</p><button className="secondary-button" onClick={() => { setQuery(""); setFilter("全部"); }}>清除筛选</button></div>
              )}
            </div>
          </section>

          <aside className="detail-panel" aria-labelledby="detail-title">
            <div className="detail-head">
              <div className="detail-brand"><BrandMark item={selected} /><div><span className="eyebrow">{selected.type} · {selected.group}</span><h2 id="detail-title">{selected.name}</h2><a href={selected.domain.includes(".") ? `https://${selected.domain}` : "#"} target="_blank" rel="noreferrer">{selected.domain}<ArrowUpRight size={14} /></a></div></div>
              <div className="detail-actions">
                <button className={`icon-button ${selected.favorite ? "is-favorite" : ""}`} onClick={() => toggleFavorite(selected.id)} aria-label={selected.favorite ? "取消收藏" : "添加收藏"}><Heart size={19} fill={selected.favorite ? "currentColor" : "none"} /></button>
                <button className="icon-button" aria-label="编辑项目"><Edit3 size={18} /></button>
                <button className="icon-button" aria-label="更多操作"><MoreHorizontal size={19} /></button>
              </div>
            </div>

            <div className="detail-section">
              <div className="field-label"><span>用户名</span></div>
              <div className="secret-field"><span>{selected.username}</span><button className="icon-button" onClick={() => copyValue(selected.username, "用户名")} aria-label="复制用户名"><Copy size={17} /></button></div>
            </div>

            <div className="detail-section">
              <div className="field-label"><span>密码</span><span className="password-meta">{selected.password.length} 位</span></div>
              <div className="secret-field password-field"><span className={revealed ? "password-revealed" : "password-masked"}>{revealed ? selected.password : "••••••••••••••••"}</span><button className="icon-button" onClick={() => setRevealed((value) => !value)} aria-label={revealed ? "隐藏密码" : "显示密码"}>{revealed ? <EyeOff size={17} /> : <Eye size={17} />}</button><button className="icon-button" onClick={() => copyValue(selected.password, "密码")} aria-label="复制密码"><Copy size={17} /></button></div>
              <div className={`password-health health-${selected.strength}`}><span /><p><strong>密码{selected.strength}</strong>{selected.strength === "风险" ? "此密码可能已重复使用" : selected.strength === "一般" ? "建议在近期轮换" : "长度和复杂度符合建议"}</p></div>
            </div>

            <div className="detail-section security-detail">
              <div className="field-label"><span>账号保护</span></div>
              <div className={`protection-row ${selected.twoFactor ? "is-safe" : "needs-action"}`}>
                {selected.twoFactor ? <ShieldCheck size={20} /> : <AlertTriangle size={20} />}
                <div><strong>{selected.twoFactor ? "已开启双重验证" : "尚未开启双重验证"}</strong><span>{selected.twoFactor ? "即使密码泄露，账号仍有额外保护" : "建议前往服务网站启用验证器"}</span></div>
                <ChevronRight size={18} />
              </div>
            </div>

            <div className="detail-section">
              <div className="field-label"><span>备注</span></div>
              <p className="note-copy">{selected.note}</p>
            </div>

            <div className="detail-footer">
              <div><Clock3 size={15} /><span>上次修改：{selected.updated}</span></div>
              <button className="open-site-button" disabled={!selected.domain.includes(".")} onClick={() => selected.domain.includes(".") && window.open(`https://${selected.domain}`, "_blank", "noopener,noreferrer")}><Globe2 size={17} />访问网站<ArrowUpRight size={15} /></button>
            </div>
          </aside>
        </div>
      </main>

      {showAdd && (
        <div className="modal-layer" role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="add-title">
            <header><div><span className="modal-icon"><KeyRound size={20} /></span><div><h2 id="add-title">添加登录信息</h2><p>信息仅保留在当前演示会话中</p></div></div><button className="icon-button" onClick={() => setShowAdd(false)} aria-label="关闭"><X size={20} /></button></header>
            <form onSubmit={submitCredential}>
              <label>名称<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：公司邮箱" autoFocus /></label>
              <label>网站地址<input required value={form.domain} onChange={(event) => setForm({ ...form, domain: event.target.value })} placeholder="example.com" inputMode="url" /></label>
              <label>用户名<input required value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder="name@example.com" autoComplete="username" /></label>
              <label>密码<div className="form-password"><input required type="text" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="输入或生成强密码" autoComplete="new-password" /><button type="button" onClick={generatePassword}><WandSparkles size={16} />生成</button></div><small>建议至少 14 位，并混合字母、数字和符号。</small></label>
              <label>保存到<select value={form.group} onChange={(event) => setForm({ ...form, group: event.target.value })}><option>个人</option><option>工作</option><option>家庭</option><option>开发</option></select></label>
              <footer><button type="button" className="secondary-button" onClick={() => setShowAdd(false)}>取消</button><button type="submit" className="primary-button"><Plus size={17} />添加项目</button></footer>
            </form>
          </section>
        </div>
      )}

      {locked && (
        <div className="lock-layer" role="dialog" aria-modal="true" aria-labelledby="lock-title">
          <form className="lock-card" onSubmit={(event) => { event.preventDefault(); setLocked(false); setToast("密码库已解锁"); }}>
            <span className="lock-brand"><ShieldCheck size={28} /></span>
            <h2 id="lock-title">密码库已锁定</h2>
            <p>输入主密码以继续访问守钥。</p>
            <label htmlFor="master-password">主密码</label>
            <input id="master-password" type="password" autoComplete="current-password" required autoFocus placeholder="输入任意内容体验演示" />
            <button className="primary-button" type="submit"><LockKeyhole size={17} />解锁密码库</button>
            <small>演示模式不会验证或保存你输入的内容。</small>
          </form>
        </div>
      )}

      <div className={`toast ${toast ? "is-visible" : ""}`} role="status" aria-live="polite"><Clipboard size={17} />{toast}</div>
    </div>
  );
}
