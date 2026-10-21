/**
 * 客户端半：侧栏入口 + 主面板 + 插件设置区块。
 *
 * 这里是**手写**的 UMD 风格客户端包（不经构建）：
 * 宿主用 `window.__ModuleLoader__.load({ id, factory })` 装载，factory 只保证
 * `react` / `react-dom` / `@deepseek-ai/dsh-client-ui-primitives` 可用。
 * 因此：
 *  - 只用 `React.createElement`，不依赖 JSX 编译；
 *  - 不引第三方图表库，图表用自建 SVG（参考件同样做法，避免打包体积）；
 *  - 所有文案走 locale，中英各一份，`props.t` 不可用时回退内置字典。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-usage-analytics',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    /** @type {any} */
    let React;
    try {
      React = require('react');
    } catch {
      React = null;
    }
    const h = React ? React.createElement : () => null;

    const API_PREFIX = '/dsh-plugin-usage-analytics/api';
    const NS = 'dsh-plugin-usage-analytics';
    const PANEL_ID = 'usage-analytics';
    const PANEL_ORDER = 42;

    const DICT = {
      zh: {
        nav: '用量分析',
        title: '用量分析',
        subtitle: '本机工具调用与回合统计，数据只写本地',
        refresh: '刷新',
        reset: '清空数据',
        resetConfirm: '确认清空本插件的本地统计数据？此操作不可撤销。',
        loading: '加载中…',
        empty: '还没有采集到数据，先跑一轮对话试试。',
        error: '加载失败',
        retry: '重试',
        window: '统计窗口',
        days: '天',
        today: '今日',
        total: '窗口合计',
        toolCalls: '工具调用',
        toolErrors: '工具错误',
        errorRate: '错误率',
        avgMs: '平均耗时',
        turns: '回合',
        sessions: '会话',
        tokensIn: '输入 token',
        tokensOut: '输出 token',
        trend: '逐日趋势',
        topTools: 'Top 工具',
        capabilities: '能力调用',
        tool: '工具',
        calls: '调用',
        errors: '错误',
        avg: '均耗时',
        share: '占比',
        mcp: 'MCP',
        skill: '技能',
        native: '内置',
        noCapabilities: '窗口内没有 MCP / 技能调用',
        settings: '采集设置',
        collect: '采集开关',
        collectHint: '关闭后只保留查询与面板，不再记录新事件',
        sampleRate: '采样率',
        sampleRateHint: '1 表示全量采集，调低可减少写入',
        retention: '保留天数',
        retentionHint: '超过保留期的聚合行会被裁剪',
        export: '导出 NDJSON',
        flushNow: '立即落盘',
        flushed: '已落盘',
        storage: '存储',
        diagnostics: '诊断',
        latency: '无样本',
        pluginsSection: '用量分析',
        pluginsSectionHint: '查看本机工具调用统计',
        open: '打开面板',
        source: '数据来源：本机会话事件流',
      },
      en: {
        nav: 'Usage Analytics',
        title: 'Usage Analytics',
        subtitle: 'Local tool-call and turn statistics; data stays on this machine',
        refresh: 'Refresh',
        reset: 'Reset data',
        resetConfirm: 'Clear all locally stored analytics data? This cannot be undone.',
        loading: 'Loading…',
        empty: 'No data collected yet. Run a conversation first.',
        error: 'Failed to load',
        retry: 'Retry',
        window: 'Window',
        days: 'days',
        today: 'Today',
        total: 'Window total',
        toolCalls: 'Tool calls',
        toolErrors: 'Tool errors',
        errorRate: 'Error rate',
        avgMs: 'Avg duration',
        turns: 'Turns',
        sessions: 'Sessions',
        tokensIn: 'Input tokens',
        tokensOut: 'Output tokens',
        trend: 'Daily trend',
        topTools: 'Top tools',
        capabilities: 'Capabilities',
        tool: 'Tool',
        calls: 'Calls',
        errors: 'Errors',
        avg: 'Avg',
        share: 'Share',
        mcp: 'MCP',
        skill: 'Skill',
        native: 'Built-in',
        noCapabilities: 'No MCP or skill calls in this window',
        settings: 'Collection settings',
        collect: 'Collector',
        collectHint: 'Turn off to keep queries and the panel but stop recording events',
        sampleRate: 'Sample rate',
        sampleRateHint: '1 collects everything; lower values reduce writes',
        retention: 'Retention (days)',
        retentionHint: 'Aggregate rows older than this are pruned',
        export: 'Export NDJSON',
        flushNow: 'Flush now',
        flushed: 'Flushed',
        storage: 'Storage',
        diagnostics: 'Diagnostics',
        latency: 'no samples',
        pluginsSection: 'Usage Analytics',
        pluginsSectionHint: 'Inspect local tool-call statistics',
        open: 'Open panel',
        source: 'Source: local session event stream',
      },
    };

    // ── 工具函数 ────────────────────────────────────────────────────────────

    /** 内置字典的回退链：中文 → 英文 → key 本身。 */
    function builtinT(key) {
      const hit = DICT.zh[key] ?? DICT.en[key];
      return typeof hit === 'string' && hit !== '' ? hit : key;
    }

    /**
     * 取翻译函数。
     *
     * 宿主给了 `props.t` 就用宿主的，但宿主 locale 缺 key 时它可能返回空串
     * 或者原样返回 key——界面会出现空标题。这里统一兜到内置字典，
     * 缺 key 至少还能显示默认语言，而不是一片空白。
     * @param {{ t?: (key: string) => string }} [props]
     */
    function makeTranslator(props) {
      const hostT = props !== null && props !== undefined && typeof props.t === 'function' ? props.t : null;
      if (hostT === null) return builtinT;
      return (key, ...rest) => {
        let value;
        try {
          value = hostT(key, ...rest);
        } catch {
          // 宿主翻译函数抛错不应让整个面板崩掉。
          return builtinT(key);
        }
        if (typeof value !== 'string' || value === '' || value === key) return builtinT(key);
        return value;
      };
    }

    function formatNumber(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return '0';
      if (Math.abs(n) >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
      if (Math.abs(n) >= 10_000) return `${Math.round(n / 100) / 10}k`;
      return String(Math.round(n));
    }

    function formatMs(value) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) return null;
      if (n < 1000) return `${Math.round(n)}ms`;
      return `${Math.round(n / 100) / 10}s`;
    }

    /** 统一取信封里的 value。 */
    async function apiGet(path, signal) {
      const response = await fetch(`${API_PREFIX}${path}`, {
        signal,
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      });
      const payload = await response.json();
      if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
        const message = payload?.error?.message ?? `HTTP ${response.status}`;
        throw new Error(message);
      }
      return payload.value;
    }

    /** 手写 hook：一次拉取 + 手动/定时刷新。 */
    function useAnalytics(days) {
      const [state, setState] = React.useState({ loading: true, error: null, overview: null, series: null });
      const [tick, setTick] = React.useState(0);
      const bump = React.useCallback(() => setTick((value) => value + 1), []);

      React.useEffect(() => {
        const controller = new AbortController();
        let alive = true;
        setState((prev) => ({ ...prev, loading: true, error: null }));
        (async () => {
          try {
            const [overview, series] = await Promise.all([
              apiGet(`/overview?days=${days}`, controller.signal),
              apiGet(`/series?days=${Math.max(days, 14)}`, controller.signal),
            ]);
            if (alive) setState({ loading: false, error: null, overview, series });
          } catch (error) {
            if (alive && error?.name !== 'AbortError') {
              setState((prev) => ({ ...prev, loading: false, error: String(error?.message ?? error) }));
            }
          }
        })();
        const timer = setInterval(() => void bump(), 15000);
        return () => {
          alive = false;
          controller.abort();
          clearInterval(timer);
        };
      }, [days, tick, bump]);

      return { ...state, refresh: bump };
    }

    // ── 视觉原子 ────────────────────────────────────────────────────────────

    // 主题 token：只用宿主暴露的 --dsw-alias-*，并给每个 token 留回退值，
    // 这样 token 改名时最多是外观降级，不会让组件崩掉。
    const token = {
      labelPrimary: 'var(--dsw-alias-label-primary, currentColor)',
      labelSecondary: 'var(--dsw-alias-label-secondary, currentColor)',
      labelTertiary: 'var(--dsw-alias-label-tertiary, currentColor)',
      labelCaption: 'var(--dsw-alias-label-caption, currentColor)',
      borderL1: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.18))',
      borderL2: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.24))',
      bgLayer1: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))',
      bgLayer2: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.1))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12))',
      error: 'var(--dsw-alias-state-error-primary, #e5484d)',
      business: 'var(--dsw-alias-state-business-primary, #3a7afe)',
    };

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 2px', color: token.labelPrimary },
      header: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
      title: { fontSize: 16, fontWeight: 600, margin: 0, color: token.labelPrimary },
      subtitle: { fontSize: 12, margin: 0, color: token.labelTertiary },
      toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      button: {
        fontSize: 12,
        padding: '5px 10px',
        borderRadius: 6,
        border: `1px solid ${token.borderL2}`,
        background: token.bgLayer1,
        color: token.labelPrimary,
        cursor: 'pointer',
      },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))', gap: 10 },
      card: {
        border: `1px solid ${token.borderL1}`,
        borderRadius: 10,
        padding: '10px 12px',
        background: token.bgLayer1,
        color: token.labelPrimary,
      },
      kpiLabel: { fontSize: 11, marginBottom: 4, color: token.labelTertiary },
      kpiValue: { fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: token.labelPrimary },
      kpiHint: { fontSize: 11, marginTop: 2, color: token.labelCaption },
      sectionTitle: { fontSize: 13, fontWeight: 600, margin: '0 0 8px', color: token.labelPrimary },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12, color: token.labelSecondary },
      th: { textAlign: 'left', padding: '6px 8px', fontWeight: 500, borderBottom: `1px solid ${token.borderL1}`, color: token.labelTertiary },
      td: { padding: '6px 8px', borderBottom: `1px solid ${token.borderL1}`, color: token.labelSecondary },
      num: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
      muted: { fontSize: 12, color: token.labelTertiary },
      error: { fontSize: 12, color: token.error },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: `1px solid ${token.borderL1}` },
      pill: { fontSize: 10, padding: '1px 6px', borderRadius: 999, border: `1px solid ${token.borderL2}`, color: token.labelTertiary },
      bar: { height: 6, borderRadius: 3, background: token.business, opacity: 0.55 },
      barTrack: { height: 6, borderRadius: 3, background: token.bgLayer2, overflow: 'hidden', minWidth: 60 },
    };

    function Kpi({ label, value, hint }) {
      return h('div', { style: styles.card },
        h('div', { style: styles.kpiLabel }, label),
        h('div', { style: styles.kpiValue }, value),
        hint ? h('div', { style: styles.kpiHint }, hint) : null);
    }

    /** 逐日柱状图：纯 SVG，无依赖。 */
    function TrendChart({ series, t }) {
      const rows = Array.isArray(series) ? series.slice(-14) : [];
      if (rows.length === 0) return h('div', { style: styles.muted }, t('empty'));
      const max = Math.max(1, ...rows.map((row) => Number(row.toolCalls) || 0));
      const width = 100;
      const height = 40;
      const slot = width / rows.length;
      return h('div', null,
        h('svg', {
          viewBox: `0 0 ${width} ${height + 8}`,
          preserveAspectRatio: 'none',
          style: { width: '100%', height: 96, overflow: 'visible' },
          role: 'img',
          'aria-label': t('trend'),
        },
          rows.map((row, index) => {
            const calls = Number(row.toolCalls) || 0;
            const errors = Number(row.toolErrors) || 0;
            const barHeight = Math.max(calls > 0 ? 1.5 : 0, (calls / max) * height);
            const errorHeight = calls > 0 ? (errors / max) * height : 0;
            const x = index * slot + slot * 0.15;
            return h('g', { key: row.day },
              h('rect', {
                x, y: height - barHeight, width: slot * 0.7, height: barHeight,
                rx: 0.6, fill: token.business, opacity: 0.45,
              }),
              errorHeight > 0
                ? h('rect', {
                    x, y: height - errorHeight, width: slot * 0.7, height: errorHeight,
                    rx: 0.6, fill: token.error, opacity: 0.8,
                  })
                : null);
          }),
        ),
        h('div', { style: { ...styles.muted, display: 'flex', justifyContent: 'space-between', marginTop: 4 } },
          h('span', null, rows[0]?.day ?? ''),
          h('span', null, rows[rows.length - 1]?.day ?? '')),
      );
    }

    function ToolTable({ tools, t }) {
      const rows = Array.isArray(tools) ? tools : [];
      if (rows.length === 0) return h('div', { style: styles.muted }, t('empty'));
      return h('table', { style: styles.table },
        h('thead', null,
          h('tr', null,
            h('th', { style: styles.th }, t('tool')),
            h('th', { style: { ...styles.th, ...styles.num } }, t('calls')),
            h('th', { style: { ...styles.th, ...styles.num } }, t('errors')),
            h('th', { style: { ...styles.th, ...styles.num } }, t('avg')),
            h('th', { style: { ...styles.th, ...styles.num } }, t('share')))),
        h('tbody', null,
          rows.map((row) => h('tr', { key: row.tool },
            h('td', { style: styles.td },
              h('span', { style: { marginRight: 6 } }, row.tool),
              row.cap && row.cap !== 'native'
                ? h('span', { style: styles.pill }, t(row.cap === 'mcp' ? 'mcp' : 'skill'))
                : null),
            h('td', { style: { ...styles.td, ...styles.num } }, formatNumber(row.calls)),
            h('td', { style: { ...styles.td, ...styles.num, color: row.errors > 0 ? token.error : undefined } }, formatNumber(row.errors)),
            h('td', { style: { ...styles.td, ...styles.num } }, formatMs(row.avgMs) ?? t('latency')),
            h('td', { style: { ...styles.td, ...styles.num } }, `${row.share ?? 0}%`)))));
    }

    function CapabilityList({ capabilities, t }) {
      const rows = Array.isArray(capabilities) ? capabilities : [];
      if (rows.length === 0) return h('div', { style: styles.muted }, t('noCapabilities'));
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        rows.map((row) => {
          const max = Math.max(1, ...rows.map((item) => Number(item.calls) || 0));
          const width = Math.max(4, Math.round(((Number(row.calls) || 0) / max) * 100));
          return h('div', { key: `${row.type}:${row.key}` },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 } },
              h('span', null, row.key, ' ', h('span', { style: styles.pill }, t(row.type === 'mcp' ? 'mcp' : 'skill'))),
              h('span', { style: styles.muted }, formatNumber(row.calls))),
            h('div', { style: styles.barTrack }, h('div', { style: { ...styles.bar, width: `${width}%` } })));
        }));
    }

    /** 一行设置项：标签 + 说明 + 控件。 */
    function SettingRow({ label, hint, control }) {
      return h('div', { style: styles.row },
        h('div', { style: { minWidth: 0 } },
          h('div', { style: { fontSize: 12 } }, label),
          hint ? h('div', { style: styles.muted }, hint) : null),
        h('div', { style: { flexShrink: 0 } }, control));
    }

    function useSettings(t) {
      const [settings, setSettings] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState('');

      const load = React.useCallback(async () => {
        try {
          setSettings(await apiGet('/settings'));
        } catch {
          /* 设置读失败不阻塞面板 */
        }
      }, []);
      React.useEffect(() => { void load(); }, [load]);

      const patch = React.useCallback(async (body) => {
        setBusy(true);
        try {
          const response = await fetch(`${API_PREFIX}/settings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body),
          });
          const payload = await response.json();
          if (payload?.ok === true) setSettings(payload.value);
        } catch {
          setNotice(t('error'));
        } finally {
          setBusy(false);
        }
      }, [t]);

      return { settings, busy, notice, setNotice, patch, reload: load };
    }

    // ── 面板 ────────────────────────────────────────────────────────────────

    function AnalyticsPanel(props) {
      const t = makeTranslator(props);
      const [days, setDays] = React.useState(7);
      const { loading, error, overview, series, refresh } = useAnalytics(days);
      const { settings, patch, notice } = useSettings(t);
      const [actionNotice, setActionNotice] = React.useState('');

      const totals = overview?.totals ?? {};
      const today = overview?.today ?? {};
      const isEmpty = !loading && !error && (totals.toolCalls ?? 0) === 0 && (overview?.sessions ?? 0) === 0;

      const doReset = React.useCallback(async () => {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(t('resetConfirm'))) return;
        try {
          // 服务端要求显式确认令牌：window.confirm 在内嵌 webview 里可能被
          // 屏蔽，光靠前端确认挡不住误触。
          await fetch(`${API_PREFIX}/reset?confirm=RESET`, { method: 'POST', credentials: 'same-origin' });
          refresh();
        } catch {
          setActionNotice(t('error'));
        }
      }, [refresh, t]);

      const doFlush = React.useCallback(async () => {
        try {
          await fetch(`${API_PREFIX}/flush`, { method: 'POST', credentials: 'same-origin' });
          setActionNotice(t('flushed'));
          setTimeout(() => setActionNotice(''), 2000);
        } catch {
          setActionNotice(t('error'));
        }
      }, [t]);

      const dayOptions = [1, 7, 14, 30, 90];

      const doExport = React.useCallback(() => {
        // 复用 REST /export：它带 content-disposition，交给浏览器当附件下载，
        // 比在客户端拼 CSV 少一层格式化逻辑，也更省内存。
        try {
          const anchor = document.createElement('a');
          anchor.href = `${API_PREFIX}/export`;
          anchor.rel = 'noopener';
          anchor.download = '';
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
        } catch {
          setActionNotice(t('error'));
        }
      }, [t]);

      return h('div', { style: styles.wrap },
        h('div', { style: styles.header },
          h('div', null,
            h('h2', { style: styles.title }, t('title')),
            h('p', { style: styles.subtitle }, t('subtitle'))),
          h('div', { style: styles.toolbar },
            h('select', {
              value: days,
              onChange: (event) => setDays(Number(event.target.value)),
              style: { ...styles.button, appearance: 'auto' },
              'aria-label': t('window'),
            }, dayOptions.map((value) => h('option', { key: value, value }, `${value} ${t('days')}`))),
            h('button', { type: 'button', style: styles.button, onClick: refresh }, t('refresh')),
            h('button', { type: 'button', style: styles.button, onClick: doExport }, t('export')),
            h('button', { type: 'button', style: styles.button, onClick: doFlush }, t('flushNow')),
            h('button', { type: 'button', style: { ...styles.button, color: token.error }, onClick: doReset }, t('reset')))),
        error
          ? h('div', { style: styles.error }, `${t('error')}：${error}`, h('button', { type: 'button', style: { ...styles.button, marginLeft: 8 }, onClick: refresh }, t('retry')))
          : null,
        loading && overview === null ? h('div', { style: styles.muted }, t('loading')) : null,
        isEmpty ? h('div', { style: styles.muted }, t('empty')) : null,
        !isEmpty && overview
          ? h('div', null,
              h('div', { style: styles.grid },
                h(Kpi, { label: t('toolCalls'), value: formatNumber(totals.toolCalls), hint: `${t('today')} ${formatNumber(today.toolCalls)}` }),
                h(Kpi, { label: t('toolErrors'), value: formatNumber(totals.toolErrors), hint: `${t('errorRate')} ${totals.errorRate ?? 0}%` }),
                h(Kpi, { label: t('avgMs'), value: formatMs(totals.avgMs) ?? '—', hint: `${t('turns')} ${formatNumber(totals.turns)}` }),
                h(Kpi, { label: t('sessions'), value: formatNumber(overview.sessions), hint: `${t('today')} ${formatNumber(today.sessions)}` }),
                h(Kpi, { label: t('tokensIn'), value: formatNumber(totals.tokensIn) }),
                h(Kpi, { label: t('tokensOut'), value: formatNumber(totals.tokensOut) })),
              h('div', { style: styles.card },
                h('h3', { style: styles.sectionTitle }, t('trend')),
                h(TrendChart, { series, t })),
              h('div', { style: styles.card },
                h('h3', { style: styles.sectionTitle }, t('topTools')),
                h(ToolTable, { tools: overview.tools, t })),
              h('div', { style: styles.card },
                h('h3', { style: styles.sectionTitle }, t('capabilities')),
                h(CapabilityList, { capabilities: overview.capabilities, t })))
          : null,
        settings
          ? h('div', { style: styles.card },
              h('h3', { style: styles.sectionTitle }, t('settings')),
              h(SettingRow, {
                label: t('collect'),
                hint: t('collectHint'),
                control: h('input', {
                  type: 'checkbox',
                  checked: settings.collect !== false,
                  onChange: (event) => void patch({ collect: event.target.checked }),
                  'aria-label': t('collect'),
                }),
              }),
              h(SettingRow, {
                label: `${t('sampleRate')}: ${Math.round((Number(settings.sampleRate) || 0) * 100)}%`,
                hint: t('sampleRateHint'),
                control: h('input', {
                  type: 'range',
                  min: 0.1,
                  max: 1,
                  step: 0.1,
                  value: Number(settings.sampleRate) || 1,
                  onChange: (event) => void patch({ sampleRate: Number(event.target.value) }),
                  style: { width: 140 },
                  'aria-label': t('sampleRate'),
                }),
              }),
              h(SettingRow, {
                label: `${t('retention')}: ${settings.retentionDays ?? 90}`,
                hint: t('retentionHint'),
                control: h('input', {
                  type: 'number',
                  min: 1,
                  max: 400,
                  value: settings.retentionDays ?? 90,
                  onChange: (event) => void patch({ retentionDays: Number(event.target.value) }),
                  style: { ...styles.button, width: 80 },
                  'aria-label': t('retention'),
                }),
              }))
          : null,
        actionNotice ? h('div', { style: styles.muted }, actionNotice) : null,
        notice ? h('div', { style: styles.error }, notice) : null,
        h('div', { style: styles.muted }, t('source')));
    }

    /** 侧栏图标：16px 线性柱状图。 */
    function AnalyticsIcon() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M2.5 13.5V8M6 13.5V4.5M9.5 13.5V6.5M13 13.5V2.5', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }));
    }

    /** 插件页里的配置区块：给一个入口 + 一句说明。 */
    function AnalyticsSettingsSection(props) {
      const t = makeTranslator(props);
      return h('div', { style: styles.card },
        h('div', { style: styles.title }, t('pluginsSection')),
        h('div', { style: styles.muted }, t('pluginsSectionHint')),
        props?.openPanel
          ? h('button', { type: 'button', style: { ...styles.button, marginTop: 8 }, onClick: props.openPanel }, t('open'))
          : null);
    }

    // ── 注册 ────────────────────────────────────────────────────────────────

    function apply(ctx) {
      ctx.effect(() => {
        const disposers = [];
        for (const [lang, dict] of Object.entries(DICT)) {
          const dispose = ctx.locale.register(NS, lang, dict);
          if (typeof dispose === 'function') disposers.push(dispose);
        }
        return () => {
          for (const dispose of disposers) dispose();
        };
      }, 'dsh-plugin-usage-analytics: dictionaries');

      const t = ctx.locale.bind(NS);

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => ({ openPanel: () => ctx.layout.selectPanel(PANEL_ID) }),
      }, AnalyticsPanel));

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: PANEL_ORDER,
        label: () => t('nav'),
        locale: NS,
      }, AnalyticsIcon));

      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: 'dsh-plugin-usage-analytics',
        locale: NS,
        inject: () => ({ openPanel: () => ctx.layout.selectPanel(PANEL_ID) }),
      }, AnalyticsSettingsSection));
    }

    exports.PANEL_ID = PANEL_ID;
    exports.AnalyticsPanel = AnalyticsPanel;
    exports.AnalyticsSettingsSection = AnalyticsSettingsSection;
    exports.apply = apply;
    exports.inject = ['slots', 'locale', 'layout'];
    return module.exports;
  },
});
