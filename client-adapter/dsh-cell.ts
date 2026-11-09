// Copied from dsh-theone src/client.ts (MIT). See brand-source.json.
  const cellWaves = [0.4, 0.13, 0.31, 0.17, 0.29, 0.18, -0.11, 0.25]
  const fix = (value: number) => value.toFixed(3)
  /** A smooth closed curve through the points (Catmull-Rom as cubic Béziers). */
  const closedCurve = (points: readonly (readonly [number, number])[]) => {
    const n = points.length
    let path = `M${fix(points[0][0])} ${fix(points[0][1])}`
    points.forEach((p1, i) => {
      const p0 = points[(i + n - 1) % n], p2 = points[(i + 1) % n], p3 = points[(i + 2) % n]
      path += `C${fix(p1[0] + (p2[0] - p0[0]) / 6)} ${fix(p1[1] + (p2[1] - p0[1]) / 6)} ${fix(p2[0] - (p3[0] - p1[0]) / 6)} ${fix(p2[1] - (p3[1] - p1[1]) / 6)} ${fix(p2[0])} ${fix(p2[1])}`
    })
    return `${path}Z`
  }
  type CellPose = { membrane: string; x: number; y: number; r: number; stem?: string }
  const cellFrame = (t: number, pace: readonly number[] = cellWaves): CellPose => {
    const { sin, cos, PI } = Math
    const points = Array.from({ length: 44 }, (_, i) => {
      const a = i / 44 * 2 * PI, r = 7.4 + 0.12 * sin(pace[7] * t) + 0.22 * sin(2 * a + pace[5] * t) + 0.07 * sin(3 * a + pace[6] * t)
      return [10 + r * cos(a), 10 + r * sin(a)] as const
    })
    return { membrane: closedCurve(points), x: 10 + 0.6 * sin(pace[1] * t) + 0.25 * sin(pace[2] * t), y: 10 + 0.55 * sin(pace[3] * t) + 0.2 * sin(pace[4] * t), r: 2.9 + 0.12 * sin(pace[0] * t) }
  }
  /** Halloween: the same cell, squat and lobed like a pumpkin (two notches top and bottom, a dip under the stem), with a swaying stem. */
  const pumpkinY = 10.9
  const pumpkinRibs = `M6.6 ${pumpkinY - 5.2}C5.2 ${pumpkinY - 2} 5.2 ${pumpkinY + 2} 6.6 ${pumpkinY + 5.2}M13.4 ${pumpkinY - 5.2}C14.8 ${pumpkinY - 2} 14.8 ${pumpkinY + 2} 13.4 ${pumpkinY + 5.2}`
  const pumpkinFrame = (t: number, pace: readonly number[] = cellWaves): CellPose => {
    const { sin, cos, exp, abs, max, atan2, PI } = Math, swell = 0.1 * sin(pace[7] * t)
    const points = Array.from({ length: 64 }, (_, i) => {
      const a = i / 64 * 2 * PI, fromTop = atan2(sin(a + PI / 2), cos(a + PI / 2)), shape = sin(2 * a + pace[5] * t)
      const dent = 0.55 * abs(sin(a)) * max(0, -cos(4 * a)) + 0.45 * exp(-fromTop * fromTop / 0.06)
      return [10 + (7.9 + swell + 0.12 * shape - dent) * cos(a), pumpkinY + (6.8 + swell + 0.1 * shape - dent) * sin(a)] as const
    })
    const top = pumpkinY - 6.35 - swell, sway = 0.25 * sin(pace[2] * t)
    return { membrane: closedCurve(points), stem: `M10 ${fix(top + 0.2)}C${fix(10 + sway * 0.3)} ${fix(top - 1)} ${fix(10.4 + sway)} ${fix(top - 1.9)} ${fix(11.5 + sway)} ${fix(top - 2.3)}`,
      x: 10 + 0.45 * sin(pace[1] * t), y: pumpkinY + 0.4 * sin(pace[3] * t), r: 2.6 + 0.1 * sin(pace[0] * t) }
  }
  function CellSymbol({ state, spooky = false }: { state?: 'idle' | 'active'; spooky?: boolean }) {
    const svg = useRef<SVGSVGElement>(null), tempo = useRef(0.7), pose = spooky ? pumpkinFrame : cellFrame, still = pose(0), live = !!state
    tempo.current = state === 'active' ? 1 : 0.7
    useEffect(() => {
      if (!live || !svg.current || typeof matchMedia !== 'function' || matchMedia('(prefers-reduced-motion: reduce)').matches) return
      const part = (name: string) => svg.current!.querySelector(`[data-part="${name}"]`)!
      const membrane = part('membrane'), nucleus = part('nucleus'), stem = spooky ? part('stem') : undefined
      const paint = (frame: CellPose) => {
        membrane.setAttribute('d', frame.membrane)
        if (stem && frame.stem) stem.setAttribute('d', frame.stem)
        nucleus.setAttribute('cx', fix(frame.x)); nucleus.setAttribute('cy', fix(frame.y)); nucleus.setAttribute('r', fix(frame.r))
      }
      // Slightly different tempos per mark, so two marks on screen never move in step.
      const pace = cellWaves.map(wave => wave * (0.85 + Math.random() * 0.3))
      let t = 0, speed = tempo.current, last = performance.now(), frame = requestAnimationFrame(function step(now) {
        const dt = Math.min(0.05, (now - last) / 1000); last = now
        speed += (tempo.current - speed) * Math.min(1, dt * 2); t += dt * speed
        paint(pose(t, pace)); frame = requestAnimationFrame(step)
      })
      return () => { cancelAnimationFrame(frame); paint(pose(0)) }
    }, [live, spooky])
    return h('svg', { ref: svg, className: 'theone-symbol', 'data-spooky': spooky, viewBox: '0 0 20 20', width: 20, height: 20, 'aria-hidden': true, focusable: false },
      spooky && h('path', { d: pumpkinRibs, fill: 'none', stroke: 'currentColor', strokeWidth: 0.9, strokeLinecap: 'round', opacity: 0.38 }),
      h('path', { 'data-part': 'membrane', d: still.membrane, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
      spooky && h('path', { 'data-part': 'stem', className: 'theone-symbol-stem', d: still.stem, fill: 'none', strokeWidth: 1.5, strokeLinecap: 'round' }),
      h('circle', { 'data-part': 'nucleus', cx: fix(still.x), cy: fix(still.y), r: fix(still.r), fill: 'currentColor' }))
  }
  /** The sidebar entry always breathes, a little livelier while main chat is open; everywhere else the cell holds still. */
  const symbol = (state?: 'idle' | 'active', spooky = false) => h(CellSymbol, { state, spooky })

