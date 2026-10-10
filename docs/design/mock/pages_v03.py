# v0.3 新增畫面（由 build.py 的 render(p) 以 exec 執行；p、HD、TAB、wrap、sheettop、home 來自 render）
import random
X=f'''<style>
.h1{{font-size:34px;font-weight:700;line-height:1.2}}
.kpis{{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:0 16px}}.kpi{{background:{p['card']};border:1px solid {p['border']};border-radius:16px;padding:10px 12px}}.kpi b{{display:block;font-size:22px;font-weight:700;line-height:1.3}}
.ct{{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px}}.ct h2{{font-size:18px}}
.lg{{display:flex;gap:14px;flex-wrap:wrap;margin-top:6px}}.lg span{{display:flex;align-items:center;gap:6px}}
.fld label{{display:block;font-weight:600;margin:12px 0 6px}}.inp{{height:48px;border-radius:12px;border:1.5px solid {p['input']};display:flex;align-items:center;justify-content:space-between;padding:0 14px;background:{p['background']}}}.inp.f{{border-color:{p['ring']};border-width:2px}}.ph{{color:{p['muted_fg']}}}
.btn.dis{{background:{p['secondary']};color:{p['muted_fg']}}}
.grp{{background:{p['card']};border:1px solid {p['border']};border-radius:16px;margin:0 16px}}.gi{{display:flex;justify-content:space-between;align-items:center;min-height:52px;padding:0 16px;border-bottom:1px solid {p['border']}}}.gi:last-child{{border:0}}
.gh{{padding:18px 32px 6px;color:{p['muted_fg']};font-weight:600}}.help{{padding:6px 32px 0;color:{p['muted_fg']}}}
.stp{{width:64px;height:64px;border-radius:32px;background:{p['secondary']};display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:600}}
</style>'''
# ---------- fill macros ----------
fill_macros=f'''{X}<div style="position:absolute;inset:0">{home.replace('<div class="toast"','<div style="display:none"')}</div><div class="dim"></div><div class="sheet" style="height:610px">{sheettop}
<div style="padding:4px 20px 0"><div style="display:flex;justify-content:space-between;align-items:flex-start"><div><div class="mu num" style="font-weight:600">步驟 1 / 2</div><div style="font-size:20px;font-weight:700">先補上營養素</div></div><span class="demo">示意</span></div>
<div class="mu" style="margin-top:4px">這個品項只有熱量，補上一次之後就不用再填。</div>
<div style="margin-top:12px;padding:12px 14px;border-radius:12px;background:{p['secondary']}"><div style="font-weight:600">舒肥雞胸 黑胡椒</div><div class="mu num">7-11 · 1 包 · 150 kcal</div></div>
<div class="fld num"><label>蛋白質（g，每份）</label><div class="inp"><span>28</span></div>
<label>碳水（g，每份）</label><div class="inp"><span>2</span></div>
<label>脂肪（g，每份）</label><div class="inp f"><span class="ph">必填，可以填 0</span></div></div>
<div class="mu" style="margin:12px 0">還差 1 項才能下一步</div><div class="btn dis">下一步</div></div></div>'''
# ---------- trends ----------
random.seed(7)
days=[random.choice([1850,1920,2050,2100,2180,2240,2390,1700,1980,2010]) for _ in range(28)]
inc={3,11,19}  # 記錄不完整
for i in inc: days[i]=random.choice([780,920,1050])
W,H,GOAL,MAX=318,150,2200,2600
bw=W/28
bars=""
for i,v in enumerate(days):
  h=v/MAX*H;x=i*bw+1.5
  if i%7==0 and i: bars+=f'<line x1="{i*bw:.1f}" x2="{i*bw:.1f}" y1="0" y2="{H}" stroke="{p["border"]}" stroke-width="1"/>'
  if i==27: continue
  if i==26: bars+=f'<rect x="{x:.1f}" y="{H-h*.55:.1f}" width="{bw-3:.1f}" height="{h*.55:.1f}" rx="2" fill="{p["chart_bar"]}" opacity=".5"/>'; continue
  if i in inc: bars+=f'<rect x="{x:.1f}" y="{H-h:.1f}" width="{bw-3:.1f}" height="{h:.1f}" fill="url(#hatch)" stroke="{p["chart_hatch"]}" stroke-width="1"/><text x="{x+(bw-3)/2:.1f}" y="{H-h-4:.1f}" text-anchor="middle" font-size="11" fill="{p["chart_hatch"]}">!</text>'
  else: bars+=f'<rect x="{x:.1f}" y="{H-h:.1f}" width="{bw-3:.1f}" height="{h:.1f}" rx="2" fill="{p["chart_bar"]}"/>'
gy=H-GOAL/MAX*H
kc=f'''<svg width="{W}" height="{H+22}" role="img" aria-labelledby="kt"><title id="kt">近 4 週每日熱量</title><defs><pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="5" fill="{p["chart_hatch"]}"/></pattern></defs>
{bars}<line x1="0" x2="{W}" y1="{gy:.1f}" y2="{gy:.1f}" stroke="{p["chart_goal"]}" stroke-width="1.5" stroke-dasharray="5 4"/>
<text x="0" y="{H+18}" font-size="16" fill="{p["muted_fg"]}">9/15（一）</text><text x="{W}" y="{H+18}" font-size="16" text-anchor="end" fill="{p["muted_fg"]}">10/11（日）</text></svg>'''
wt=[74.1-0.035*i+random.uniform(-.35,.35) for i in range(27)]
ma=[sum(wt[max(0,i-6):i+1])/len(wt[max(0,i-6):i+1]) for i in range(28)]
lo,hi=72.4,74.8;WH=120
Y=lambda v: WH-(v-lo)/(hi-lo)*WH
dots="".join(f'<circle cx="{i*bw+bw/2:.1f}" cy="{Y(v):.1f}" r="2.5" fill="{p["chart_weight"]}"/>' for i,v in enumerate(wt) if i not in (5,6,13,20))
pl=" ".join(f"{i*bw+bw/2:.1f},{Y(v):.1f}" for i,v in enumerate(ma))
ma27=ma[-1]
exp=f'<line x1="{bw/2:.1f}" y1="{Y(ma[0]):.1f}" x2="{26*bw+bw/2:.1f}" y2="{Y(ma[0]-1.1):.1f}" stroke="{p["chart_expected"]}" stroke-width="2" stroke-dasharray="6 5"/>'
wc=f'''<svg width="{W}" height="{WH+22}" role="img" aria-labelledby="wt"><title id="wt">體重 7 日平均與預期變化</title>{exp}<polyline points="{pl}" fill="none" stroke="{p["chart_avg"]}" stroke-width="3" stroke-linejoin="round"/>{dots}
<text x="0" y="{WH+18}" font-size="16" fill="{p["muted_fg"]}">9/15（一）</text><text x="{W}" y="{WH+18}" font-size="16" text-anchor="end" fill="{p["muted_fg"]}">10/11（日）</text></svg>'''
trends=f'''{X}{HD}<div class="top" style="padding-bottom:4px"><span class="h1">趨勢</span><span class="demo">示意</span></div>
<div style="padding:0 16px 10px;display:flex;justify-content:space-between;align-items:center"><span class="mu num" style="font-weight:500">本週 10/5（一）–10/11（日）</span><span style="min-height:44px;display:flex;align-items:center;font-weight:600">‹ 上週</span></div>
<div class="kpis num"><div class="kpi"><span class="mu">平均攝取</span><b>1,980</b><span class="mu">kcal/天</span></div><div class="kpi"><span class="mu">平均赤字</span><b>670</b><span class="mu">kcal/天</span></div><div class="kpi"><span class="mu">蛋白質達標</span><b style="color:{p['protein']}">5/7</b><span class="mu">天</span></div></div>
<div class="card" style="padding:14px 16px;margin-top:12px"><div class="ct"><h2>每日熱量・近 4 週</h2><span class="mu">kcal</span></div>{kc}
<div class="lg mu"><span><svg width="18" height="4"><line x1="0" x2="18" y1="2" y2="2" stroke="{p['chart_goal']}" stroke-width="1.5" stroke-dasharray="5 4"/></svg>目標 2,200</span><span><svg width="14" height="14"><rect width="14" height="14" fill="url(#hatch)" stroke="{p['chart_hatch']}"/></svg>! 記錄不完整 3 天</span></div></div>
<div class="card" style="padding:14px 16px;margin-top:12px;margin-bottom:120px"><div class="ct"><h2>體重</h2><span style="font-weight:700;color:{p['primary'] if p is DARK else p['foreground']};min-height:44px;display:flex;align-items:center">＋ 記體重</span></div>
<div class="num" style="margin:-4px 0 8px"><b style="font-size:28px">72.9</b> <span class="mu">kg · 7 日平均，4 週少了 0.9 kg</span></div>{wc}
<div class="lg mu"><span><svg width="18" height="4"><line x1="0" x2="18" y1="2" y2="2" stroke="{p['chart_avg']}" stroke-width="3"/></svg>7 日平均</span><span><svg width="18" height="4"><line x1="0" x2="18" y1="2" y2="2" stroke="{p['chart_expected']}" stroke-width="2" stroke-dasharray="6 5"/></svg>依赤字預期</span><span><svg width="8" height="8"><circle cx="4" cy="4" r="3" fill="{p['chart_weight']}"/></svg>每日</span></div></div>
{TAB("趨勢")}'''
# ---------- weight sheet (over trends) ----------
weight=f'''{X}<div style="position:absolute;inset:0">{trends}</div><div class="dim"></div><div class="sheet" style="height:520px">
<div class="grab"></div><div style="padding:4px 20px 0"><div style="display:flex;justify-content:space-between;align-items:center"><div style="font-size:20px;font-weight:700">記體重</div><span class="demo">示意</span></div>
<div class="gi" style="padding:0;margin-top:10px;border-top:1px solid {p['border']}"><span>日期</span><span class="num" style="font-weight:600;min-height:44px;display:flex;align-items:center">今天 10/10（六） ›</span></div>
<div style="display:flex;align-items:center;justify-content:space-between;margin:26px 0 8px"><div class="stp">−</div><div style="text-align:center"><div class="num" style="font-size:56px;font-weight:700;letter-spacing:-1.5px;line-height:1.1">72.6</div><div class="mu">kg · 點數字可以直接輸入</div></div><div class="stp">＋</div></div>
<div class="mu num" style="text-align:center;margin-bottom:22px">上次 72.6 kg（10/9）· 每按一下 0.1 kg</div><div class="btn">記錄</div></div></div>'''
# ---------- settings ----------
settings=f'''{X}{HD}<div class="top" style="padding-bottom:4px"><span class="h1">設定</span><span class="demo">示意</span></div>
<div class="gh">每日目標</div><div class="grp num"><div class="gi"><span>熱量</span><span class="mu">2,200 kcal ›</span></div><div class="gi"><span>蛋白質</span><span class="mu">160 g ›</span></div><div class="gi"><span>碳水</span><span class="mu">240 g ›</span></div><div class="gi"><span>脂肪</span><span class="mu">65 g ›</span></div></div>
<div class="gh">每日消耗</div><div style="margin:0 16px" class="fld num"><div class="inp f"><span>2,650</span><span class="mu">kcal</span></div></div>
<div class="help">InBody 的基礎代謝 × 活動量估算，可以自己改。趨勢頁用它算赤字（每日消耗 − 攝取）。</div>
<div class="help num" style="color:{p['foreground']};font-weight:500">比熱量目標少 450 kcal，代表每天的預期赤字約 450 kcal。</div>
<div class="gh">提醒（Kyujin 傳訊息）</div><div class="grp num"><div class="gi"><span>記錄餐點</span><span class="mu">12:00、19:00 ›</span></div><div class="gi"><span>量體重</span><span class="mu">07:30 ›</span></div></div>
<div class="gh">外觀</div><div class="grp"><div class="gi"><span>深色（預設）</span><span style="color:{p['primary'] if p is DARK else p['foreground']};font-weight:700">✓</span></div><div class="gi"><span>淺色</span><span></span></div></div>
{TAB("設定")}'''
