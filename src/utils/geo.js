// 演示用平面几何与球面里程工具：道路阻断影响判定 / 绕行路径生成
const R = 6371
const rad = (d) => (d * Math.PI) / 180

// 两点球面距离（km），点格式 [lng, lat]
export function haversineKm(a, b) {
  const dLat = rad(b[1] - a[1])
  const dLng = rad(b[0] - a[0])
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// 折线总长（km）
export function pathKm(points) {
  let sum = 0
  for (let i = 1; i < points.length; i++) sum += haversineKm(points[i - 1], points[i])
  return sum
}

// 射线法：点是否在多边形内
export function pointInPolygon(pt, poly) {
  const [x, y] = pt
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

// 线段相交判定（平行/共线按不相交处理，演示精度足够）
function segIntersect(p1, p2, p3, p4) {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0])
  if (d === 0) return false
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d
  return t >= 0 && t <= 1 && u >= 0 && u <= 1
}

// 折线是否穿越多边形（任一顶点落入内部，或任一线段与边界相交）
export function pathBlocked(points, poly) {
  for (const pt of points) if (pointInPolygon(pt, poly)) return true
  for (let i = 1; i < points.length; i++) {
    for (let j = 0, k = poly.length - 1; j < poly.length; k = j++) {
      if (segIntersect(points[i - 1], points[i], poly[k], poly[j])) return true
    }
  }
  return false
}

// 生成绕行途经点：沿封闭区外接矩形四侧绕行（每侧两个方向），取最短可行方案；无解返回 null
export function detourPath(a, b, poly) {
  const lngs = poly.map((p) => p[0])
  const lats = poly.map((p) => p[1])
  for (const margin of [0.035, 0.07, 0.14]) {
    const w = Math.min(...lngs) - margin
    const e = Math.max(...lngs) + margin
    const s = Math.min(...lats) - margin
    const n = Math.max(...lats) + margin
    const nw = [w, n], ne = [e, n], sw = [w, s], se = [e, s]
    const candidates = [
      [nw, ne], [ne, nw], // 北侧绕行
      [sw, se], [se, sw], // 南侧绕行
      [nw, sw], [sw, nw], // 西侧绕行
      [ne, se], [se, ne]  // 东侧绕行
    ]
    let best = null
    for (const via of candidates) {
      const pts = [a, ...via, b]
      if (pathBlocked(pts, poly)) continue
      const km = pathKm(pts)
      if (!best || km < best.km) best = { via, km }
    }
    if (best) return best
  }
  return null
}
