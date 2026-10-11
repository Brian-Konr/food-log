# food-log design v0.1：tokens 對比計算＋mock 產生（Winter）
import asyncio,re
def lum(h):
    h=h.lstrip('#');c=[int(h[i:i+2],16)/255 for i in (0,2,4)]
    c=[x/12.92 if x<=0.04045 else ((x+0.055)/1.055)**2.4 for x in c];return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]
def cr(a,b):
    l1,l2=sorted([lum(a),lum(b)],reverse=True);return (l1+.05)/(l2+.05)
DARK=dict(background="#0B0B0C",foreground="#F4F4F2",card="#161618",popover="#1C1C1F",primary="#D4F36A",primary_fg="#0B0B0C",secondary="#232326",muted_fg="#A3A3A0",border="#2A2A2D",input="#7E7E7A",ring="#D4F36A",track="#2A2A2D",kcal="#F4F4F2",protein="#D4F36A",carb="#9E9E9A",fat="#7E7E7A",over="#F2C46B",toast="#F4F4F2",toast_fg="#0B0B0C",toast_action="#3F6E00",destructive="#FF8B7D",chart_bar="#9E9E9A",chart_goal="#F4F4F2",chart_hatch="#7E7E7A",chart_weight="#A3A3A0",chart_avg="#D4F36A",chart_expected="#F2C46B")
LIGHT=dict(background="#F5F5F3",foreground="#111111",card="#FFFFFF",popover="#FFFFFF",primary="#111111",primary_fg="#FFFFFF",secondary="#EDEDEA",muted_fg="#5E5E5B",border="#DADAD6",input="#85857F",ring="#3F6E00",track="#E8E8E4",kcal="#111111",protein="#3F6E00",carb="#5A5A55",fat="#85857F",over="#7A5200",toast="#111111",toast_fg="#FFFFFF",toast_action="#D4F36A",destructive="#B3261E",chart_bar="#5A5A55",chart_goal="#111111",chart_hatch="#85857F",chart_weight="#5E5E5B",chart_avg="#3F6E00",chart_expected="#7A5200")
CHK=[("foreground","card",4.5),("foreground","background",4.5),("foreground","popover",4.5),("muted_fg","card",4.5),("muted_fg","background",4.5),("muted_fg","popover",4.5),("muted_fg","secondary",4.5),("primary_fg","primary",4.5),("protein","card",4.5),("over","card",4.5),("over","popover",4.5),("toast_fg","toast",4.5),("toast_action","toast",4.5),("destructive","card",4.5),("input","popover",3),("ring","background",3)]+[(m,s,3) for m in ("kcal","protein","carb","fat","over") for s in ("track","card")]+[(m,"card",3) for m in ("chart_bar","chart_goal","chart_hatch","chart_weight","chart_avg","chart_expected")]
out=["| 組合 | 深色（預設） | 比值 | 淺色 | 比值 | 門檻 |","|---|---|---|---|---|---|"];ok=True
for a,b,t in CHK:
  r1=cr(DARK[a],DARK[b]);r2=cr(LIGHT[a],LIGHT[b]);ok&=r1>=t and r2>=t
  out.append(f"| `{a}` / `{b}` | `{DARK[a]}`/`{DARK[b]}` | {r1:.2f}{'' if r1>=t else ' **不過**'} | `{LIGHT[a]}`/`{LIGHT[b]}` | {r2:.2f}{'' if r2>=t else ' **不過**'} | {t} |")
open("mock/contrast-table.md","w").write("\n".join(out)+"\n");print("ALL PASS" if ok else "FAIL");[print(l) for l in out if "不過" in l]
def v(d,ind):
  m={"background":"background","foreground":"foreground","card":"card","popover":"popover","primary":"primary","primary_fg":"primary-foreground","secondary":"secondary","muted_fg":"muted-foreground","border":"border","input":"input","ring":"ring","track":"track","kcal":"macro-kcal","protein":"macro-protein","carb":"macro-carb","fat":"macro-fat","over":"over","toast":"toast","toast_fg":"toast-foreground","toast_action":"toast-action","destructive":"destructive","chart_bar":"chart-bar","chart_goal":"chart-goal","chart_hatch":"chart-incomplete","chart_weight":"chart-weight","chart_avg":"chart-weight-avg","chart_expected":"chart-expected"}
  L=[f"{ind}--{m[k]}: {d[k]};" for k in m]
  L+= [f"{ind}--card-foreground: {d['foreground']};",f"{ind}--popover-foreground: {d['foreground']};",f"{ind}--secondary-foreground: {d['foreground']};",f"{ind}--muted: {d['secondary']};",f"{ind}--accent: {d['secondary']};",f"{ind}--accent-foreground: {d['foreground']};",f"{ind}--destructive-foreground: {d['background']};"]
  return "\n".join(L)
css=f'''/* food-log design tokens v0.3（Winter，2026-10-10）
 * 由 design/mock/build.py 產生；改色改 build.py 再重跑，對比表見 DESIGN.md §3.3。
 * 預設深色（:root），淺色由設定頁切換：<html class="light">。不跟系統自動切換。
 * 變數名沿用 shadcn/ui；food-log 擴充：--track、--macro-*、--over、--toast*、--chart-*（v0.3）。
 */
@import "tailwindcss";
@custom-variant light (&:where(.light, .light *));

:root {{
  color-scheme: dark;
{v(DARK,"  ")}
  --overlay: rgba(0,0,0,.62);
  --radius: 1.375rem;           /* 22px：卡片 */
  --radius-field: 1.5rem;       /* 24px：搜尋框、膠囊 */
  --radius-sheet: 1rem;         /* 16px：Sheet 上緣 */
  --touch-min: 44px; --control-h: 48px; --chip-h: 44px; --row-min-h: 60px;
  --tabbar-h: 49px; --dock-h: 116px;   /* 常吃膠囊 44＋間距 10＋搜尋框 48＋上下 14 */
  --safe-top: env(safe-area-inset-top); --safe-bottom: env(safe-area-inset-bottom);
  --font-family-text: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang TC", "Noto Sans TC", system-ui, sans-serif;
  --font-family-display: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang TC", "Noto Sans TC", system-ui, sans-serif;
  --ease-spring: cubic-bezier(.2,.9,.3,1.1); --ease-out: cubic-bezier(.2,.8,.2,1);
  --dur-fast: 150ms; --dur-base: 250ms; --dur-bar: 400ms; --dur-sheet: 350ms; --toast-ms: 3000;
}}
.light {{
  color-scheme: light;
{v(LIGHT,"  ")}
  --overlay: rgba(17,17,17,.40);
}}

@theme inline {{
  --color-background: var(--background); --color-foreground: var(--foreground);
  --color-card: var(--card); --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover); --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary); --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary); --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted); --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent); --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive); --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border); --color-input: var(--input); --color-ring: var(--ring);
  --color-track: var(--track); --color-over: var(--over);
  --color-macro-kcal: var(--macro-kcal); --color-macro-protein: var(--macro-protein);
  --color-macro-carb: var(--macro-carb); --color-macro-fat: var(--macro-fat);
  --color-chart-bar: var(--chart-bar); --color-chart-goal: var(--chart-goal); --color-chart-incomplete: var(--chart-incomplete);
  --color-chart-weight: var(--chart-weight); --color-chart-weight-avg: var(--chart-weight-avg); --color-chart-expected: var(--chart-expected);
  --color-toast: var(--toast); --color-toast-foreground: var(--toast-foreground); --color-toast-action: var(--toast-action);
  --font-sans: var(--font-family-text); --font-display: var(--font-family-display);
  --radius-sm: calc(var(--radius) - 12px); --radius-md: calc(var(--radius) - 10px);
  --radius-lg: calc(var(--radius) - 6px); --radius-xl: var(--radius);
  --text-xs: 1rem; --text-xs--line-height: 1.5rem;   /* 最小 16px */
  --text-sm: 1rem; --text-sm--line-height: 1.5rem;
  --text-base: 1rem; --text-base--line-height: 1.5rem;
  --text-lg: 1.125rem; --text-lg--line-height: 1.625rem;
  --text-xl: 1.25rem; --text-xl--line-height: 1.75rem;
  --text-2xl: 1.75rem; --text-2xl--line-height: 2.25rem;
  --text-hero: 3.25rem; --text-hero--line-height: 3.5rem;
}}

@layer base {{
  html {{ background: var(--background); color: var(--foreground); font-family: var(--font-family-text); -webkit-text-size-adjust: 100%; }}
  input, textarea, select {{ font-size: max(16px, 1em); }}
  .tnum {{ font-variant-numeric: tabular-nums; }}
  @media (prefers-reduced-motion: reduce) {{
    *, *::before, *::after {{ animation-duration: 1ms !important; transition-duration: 1ms !important; }}
  }}
}}
'''
open("tokens.css","w").write(css)

def render(p):
  # ---------- mocks ----------
  BASE=f'''*{{box-sizing:border-box;margin:0}}body{{width:390px;height:844px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','PingFang TC',system-ui,sans-serif;color:{p['foreground']};background:{p['background']};font-size:16px;line-height:1.45;-webkit-font-smoothing:antialiased;position:relative}}
  .num{{font-variant-numeric:tabular-nums}}.mu{{color:{p['muted_fg']}}}
  .sb{{height:47px;display:flex;justify-content:space-between;align-items:center;padding:0 28px;font-weight:600}}
  .top{{padding:4px 16px 12px;display:flex;justify-content:space-between;align-items:center}}
  .demo{{font-weight:600;color:{p['over']};border:1.5px solid {p['over']};border-radius:999px;padding:0 10px;line-height:28px}}
  .card{{background:{p['card']};border:1px solid {p['border']};border-radius:22px;margin:0 16px}}
  .sum{{padding:20px}}.eb{{color:{p['muted_fg']};font-weight:600}}
  .big{{display:flex;align-items:baseline;gap:8px}}.big b{{font-size:52px;font-weight:700;letter-spacing:-1.5px;line-height:1.1}}
  .big2{{display:flex;align-items:baseline;gap:8px;margin-bottom:16px}}.big2 b{{font-size:28px;color:{p['protein']}}}
  .bar+.bar{{margin-top:10px}}.bl{{display:flex;justify-content:space-between;font-weight:500}}
  .trk{{height:6px;border-radius:99px;background:{p['track']};overflow:hidden;margin-top:4px}}.fill{{height:100%;border-radius:99px}}
  .over{{color:{p['over']};font-weight:600}}
  .sec{{display:flex;justify-content:space-between;align-items:center;padding:20px 32px 8px}}.sec h2{{font-size:20px}}
  .row{{display:flex;gap:12px;align-items:center;min-height:60px;padding:8px 16px;border-bottom:1px solid {p['border']}}}.row:last-child{{border-bottom:0}}
  .rt{{width:46px}}.rm{{flex:1;min-width:0}}.rn{{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}.rs{{color:{p['muted_fg']};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}.rk{{text-align:right;white-space:nowrap}}
  .tag{{color:{p['over']};font-weight:600}}
  .tab{{position:absolute;left:0;right:0;bottom:0;height:83px;padding-bottom:34px;display:flex;justify-content:space-around;align-items:center;background:{p['card']}F0;border-top:.5px solid {p['border']}}}
  .tab div{{min-width:64px;min-height:44px;display:flex;align-items:center;justify-content:center;color:{p['muted_fg']};font-weight:500}}.tab .on{{color:{p['primary']};font-weight:700}}
  .dock{{position:absolute;left:0;right:0;bottom:83px;padding:14px 16px 10px;background:linear-gradient(to top,{p['background']} 75%,{p['background']}00)}}
  .chips{{display:flex;gap:8px;overflow:hidden;margin-bottom:10px}}.chip{{flex:none;height:44px;padding:0 14px;border-radius:22px;display:flex;align-items:center;gap:6px;font-weight:600;background:{p['card']};border:1px solid {p['border']}}}
  .field{{display:flex;align-items:center;gap:8px;height:48px;border-radius:24px;background:{p['secondary']};padding:0 16px;color:{p['muted_fg']}}}.field .q{{color:{p['foreground']};flex:1}}.field i{{display:inline-block;width:2px;height:20px;background:{p['primary']};vertical-align:middle}}
  .toast{{position:absolute;left:16px;right:16px;min-height:56px;border-radius:14px;background:{p['toast']};color:{p['toast_fg']};display:flex;align-items:center;justify-content:space-between;padding:0 6px 0 16px;font-weight:500;box-shadow:0 8px 24px rgba(0,0,0,.4)}}.toast b{{color:{p['toast_action']};min-width:64px;min-height:44px;display:flex;align-items:center;justify-content:center}}
  .dim{{position:absolute;inset:0;background:{'rgba(0,0,0,.62)'}}}
  .sheet{{position:absolute;left:0;right:0;bottom:0;background:{p['popover']};border-radius:16px 16px 0 0;border-top:1px solid {p['border']}}}
  .grab{{width:36px;height:5px;border-radius:3px;background:{p['input']};margin:8px auto 8px}}
  .fchip{{height:44px;padding:0 16px;border-radius:22px;border:1px solid {p['border']};display:flex;align-items:center;font-weight:500;flex:none}}.fchip.on{{background:{p['foreground']};color:{p['background']};border-color:{p['foreground']}}}
  .lab{{padding:14px 16px 4px;color:{p['muted_fg']};font-weight:600}}
  .seg{{display:flex;gap:8px}}.seg div{{flex:1;height:48px;border-radius:12px;border:1px solid {p['border']};display:flex;align-items:center;justify-content:center;font-weight:600}}.seg .on{{background:{p['primary']};color:{p['primary_fg']};border-color:{p['primary']}}}
  .btn{{height:56px;border-radius:28px;background:{p['primary']};color:{p['primary_fg']};font-weight:700;font-size:18px;display:flex;align-items:center;justify-content:center}}
  .mac{{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:14px 0 18px}}.mac div{{background:{p['secondary']};border-radius:12px;padding:8px 10px}}.mac b{{display:block;font-size:18px}}
  '''
  TAB=lambda on: '<div class="tab">'+''.join(f'<div class="on">{t}</div>' if t==on else f'<div>{t}</div>' for t in ('今天','趨勢','品項','設定'))+'</div>'
  HD='<div class="sb"><span class="num">9:41</span><span>●●● ▮</span></div>'
  def bar(n,v,t,u,c):
    over=v>t
    right=f'<span class="num over">超過 {v-t:g} {u}</span>' if over else f'<span class="num mu">{v:,} / {t:,} {u}</span>'
    col=p['over'] if over else p[c]
    return f'<div class="bar"><div class="bl"><span>{n}</span>{right}</div><div class="trk"><div class="fill" style="width:{min(v/t,1)*100:.0f}%;background:{col}"></div></div></div>'
  LOG=[("07:42","全家","鮪魚飯糰","1 份",233,"7.1 g 蛋白",None),("10:15","自建","乳清蛋白（香草）","1 匙",120,"24 g 蛋白",'Kyujin 建檔'),("12:30","7-11","雞腿便當","1 份",712,"32.0 g 蛋白",None),("15:20","全家","希臘優格","1 杯",98,"10.2 g 蛋白",None),("16:05","全家","無糖豆漿","1 瓶",132,"12.6 g 蛋白",None)]
  def wrap(body): return f'<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>food-log mock（示意）</title><style>{BASE}</style></head><body>{body}</body></html>'
  rows="".join(f'<div class="row"><div class="rt num mu">{t}</div><div class="rm"><div class="rn">{n}</div><div class="rs">{s} · {q}{"" if not g else f" · <span class=tag>{g}</span>"}</div></div><div class="rk"><div class="num" style="font-weight:600">{k}</div><div class="rs num">{pr}</div></div></div>' for t,s,n,q,k,pr,g in LOG)
  home=f'''{HD}<div class="top"><span class="mu" style="font-weight:500">10月10日 星期六</span><span style="display:flex;align-items:center;gap:8px"><span class="demo">示意</span><span role="button" aria-label="記體重" style="width:44px;height:44px;display:flex;align-items:center;justify-content:center;color:{p['muted_fg']}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/></svg></span></span></div>
  <div class="card sum"><div class="eb">今天還剩</div><div class="big"><b class="num">900</b><span class="mu">kcal</span></div><div class="big2"><b class="num">75.0</b><span class="mu">g 蛋白質</span></div>
  {bar("熱量",1300,2200,"kcal","kcal")}{bar("蛋白質",85,160,"g","protein")}{bar("碳水",158,240,"g","carb")}{bar("脂肪",70,65,"g","fat")}</div>
  <div class="sec"><h2>今天的紀錄</h2><span class="mu">5 筆</span></div><div class="card" style="margin-bottom:calc(116px + 83px + 16px)">{rows}</div>
  <div class="dock"><div class="chips"><div class="chip">無糖豆漿<span class="num mu">132</span></div><div class="chip">原味雞胸肉<span class="num mu">136</span></div><div class="chip">乳清蛋白<span class="num mu">120</span></div></div>
  <div class="field">⌕ <span>搜尋 7-11、全家、我的品項</span></div></div>
  <div class="toast" style="bottom:calc(83px + 116px + 8px)"><span>已記錄 無糖豆漿 1 瓶</span><b>復原</b></div>
  {TAB("今天")}'''
  RES=[("★ 收藏 · 最近","原味雞胸肉","7-11 · 1 包 180 g",136,"28.1 g 蛋白",None),(None,"雞胸肉沙拉","全家 · 1 盒",168,"19.5 g 蛋白",None),(None,"舒肥雞胸 黑胡椒","7-11 · 1 包",150,"—","要補營養素"),(None,"雞胸肉三明治","全家 · 1 個",312,"21.0 g 蛋白",None),(None,"照燒雞胸飯糰","7-11 · 1 個",205,"—","要補營養素")]
  def rrows(sel=None): return "".join(f'<div class="row"{" style=background:{p['secondary']}" if i==sel else ""}><div class="rm"><div class="rn">{n}</div><div class="rs">{s}{"" if not g else f" · <span class=tag>{g}</span>"}</div></div><div class="rk"><div class="num" style="font-weight:600">{k}</div><div class="rs num">{pr}</div></div></div>' for i,(h,n,s,k,pr,g) in enumerate(RES))
  RR=[f'<div class="row"><div class="rm"><div class="rn">{n}</div><div class="rs">{s_}{"" if not g else f" · <span class=tag>{g}</span>"}</div></div><div class="rk"><div class="num" style="font-weight:600">{k}</div><div class="rs num">{pr}</div></div></div>' for h,n,s_,k,pr,g in RES]
  sheettop='<div class="grab"></div><div class="num mu" style="text-align:center;font-weight:500;padding-bottom:8px">還剩 900 kcal · 75.0 g 蛋白質</div>'
  search=f'''{HD}<div class="dim"></div><div class="sheet" style="top:54px">{sheettop}
  <div style="display:flex;gap:10px;align-items:center;padding:0 16px 10px"><div class="field" style="flex:1">⌕ <span class="q">雞胸<i></i></span><span>✕</span></div><span style="font-weight:600;min-height:44px;display:flex;align-items:center">取消</span></div>
  <div style="display:flex;gap:8px;padding:0 16px 4px"><div class="fchip on">全部</div><div class="fchip">收藏</div><div class="fchip">7-11</div><div class="fchip">全家</div></div>
  <div class="lab">收藏・最近吃過</div>{RR[0]}<div class="lab">7-11・全家</div>{"".join(RR[1:])}</div><div class="sb" style="position:absolute;top:0;left:0;right:0"><span class="num">9:41</span><span>●●● ▮</span></div>
  <div class="demo" style="position:absolute;top:66px;right:16px">示意</div>'''
  portion=f'''<div style="position:absolute;inset:0">{home.replace('<div class="toast"','<div style="display:none"')}</div><div class="dim"></div><div class="sheet" style="height:470px">{sheettop}
  <div style="padding:8px 20px 0"><div style="display:flex;justify-content:space-between;align-items:flex-start"><div><div style="font-size:20px;font-weight:700">原味雞胸肉</div><div class="mu">7-11 · 1 包 180 g · ★ 收藏</div></div><span class="demo">示意</span></div>
  <div class="mac num"><div><span class="mu">熱量</span><b>136</b></div><div><span class="mu">蛋白質</span><b style="color:{p['protein']}">28.1</b></div><div><span class="mu">碳水</span><b>0.8</b></div><div><span class="mu">脂肪</span><b>2.2</b></div></div>
  <div class="mu" style="font-weight:600;margin-bottom:8px">份量</div><div class="seg num"><div>½</div><div class="on">1</div><div>1.5</div><div>2</div><div>克數</div></div>
  <div class="mu num" style="margin:12px 0 14px">記錄後還剩 764 kcal · 46.9 g 蛋白質</div><div class="btn">記錄</div></div></div>'''
  
  
  ns={**globals(),**locals()}
  exec(open('mock/pages_v03.py').read(),ns)
  return ns
OUT={}
d=render(DARK)
for n in ("home","search","portion","fill_macros","weight","trends","settings"): OUT[n.replace("_","-")]=d["wrap"](d[n])
OUT["home-light"]=render(LIGHT)["wrap"](render(LIGHT)["home"]).replace('<html lang="zh-Hant">','<html lang="zh-Hant" class="light">')
for n,h in OUT.items(): open(f"mock/{n}.html","w").write(h)
from playwright.async_api import async_playwright
async def main():
  async with async_playwright() as pw:
    br=await pw.chromium.launch(executable_path="/usr/bin/google-chrome",args=["--no-sandbox"])
    for n in OUT:
      pg=await br.new_page(viewport={"width":390,"height":844},device_scale_factor=2)
      await pg.goto(f"file:///workspace/studio/projects/food-log/design/mock/{n}.html");await pg.wait_for_timeout(250)
      await pg.screenshot(path=f"mock/{n}.png");await pg.close()
    await br.close()
asyncio.run(main())
