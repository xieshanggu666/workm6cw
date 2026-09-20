import { defineStore } from 'pinia'
import { useCommandStore, roughPath } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import {
  routeHitAny, routeHitBlockage, pointInBlockages,
  intersectionPoint, offsetPointM, pointSegmentDistanceM
} from '@/utils/geo'

let rbSeq = 0
const nowStr = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

// 阻断状态机：reported 待确认 → active 已确认封路 → cleared 恢复通行（dismissed 误报撤销）
export const BLOCKAGE_STATUS = [
  { value: 'reported', label: '待确认', color: '#ff9800' },
  { value: 'active', label: '已封路', color: '#ef5350' },
  { value: 'cleared', label: '已恢复', color: '#4caf50' },
  { value: 'dismissed', label: '误报撤销', color: '#7e8aa2' }
]

export const BLOCKAGE_REASONS = [
  { value: 'flood', label: '积水漫路', icon: '🌊' },
  { value: 'landslide', label: '滑坡落石', icon: '⛰️' },
  { value: 'collapse', label: '道路坍塌', icon: '🏚️' },
  { value: 'fire', label: '火情封控', icon: '🔥' },
  { value: 'other', label: '其他', icon: '🚧' }
]

// 路线状态：normal 正常 / rerouted 已改（绕行或改派）/ suspended 挂起
export const ROUTE_STATUS = [
  { value: 'normal', label: '正常', color: '#8ba2c8' },
  { value: 'rerouted', label: '已改线', color: '#ffc107' },
  { value: 'suspended', label: '已挂起', color: '#ff7043' }
]

// 绕行尝试：法向偏移距离梯度（米），逐级加大直至越过阻断段端点圆
const DETOUR_MARGIN = 2000
const DETOUR_DISTANCES = [6000, 10000, 16000, 24000, 36000, 54000, 80000, 120000]
const DETOUR_SIDES = [1, -1]

export const useRoadblockStore = defineStore('roadblock', {
  state: () => ({
    blockages: [],
    // 地图勾绘草稿（现场上报用）：drawing 开关 + draftPath 折线点
    drawing: false,
    draftPath: [],
    // 地图定位请求（MapBoard 监听后飞向该阻断）
    focusBlockageId: null
  }),

  getters: {
    openBlockages(state) {
      return state.blockages.filter((x) => x.status === 'reported' || x.status === 'active')
    },
    activeBlockages(state) {
      return state.blockages.filter((x) => x.status === 'active')
    },
    // 研判时：待确认也视为封路（影响分析预览，确认后按方案执行）
    effectiveBlockages() {
      return this.openBlockages
    },
    // 挂起任务总数（物资派发 + 转移批次）
    suspendedCount(state) {
      const cmd = useCommandStore()
      const tr = useTransferStore()
      const dSuspend = cmd.dispatches.filter((d) => d.routeStatus === 'suspended').length
      const bSuspend = tr.batches.filter((b) => b.status !== 'closed' && b.routeStatus === 'suspended').length
      return dSuspend + bSuspend
    }
  },

  actions: {
    reset() {
      this.blockages = []
      this.drawing = false
      this.draftPath = []
      this.focusBlockageId = null
    },

    /* ---------- 现场上报 ---------- */
    // 现场人员上报道路封闭范围：path 为地图勾绘（或模拟生成）的折线，radius 为封闭带宽（米）
    report({ eventId, roadName, reason, reporter, path, radius, note }) {
      if (!Array.isArray(path) || path.length < 2) {
        return { ok: false, msg: '请先勾绘道路封闭范围（至少两个点）' }
      }
      radius = Math.max(100, Math.round(radius || 1500))
      const rb = {
        id: 'rb-' + Date.now() + '-' + ++rbSeq,
        eventId: eventId || null,
        roadName: (roadName || '').trim() || '未命名路段',
        reason: reason || 'other',
        reporter: (reporter || '').trim() || '现场队员',
        path: path.map((p) => [p[0], p[1]]),
        radius,
        note: (note || '').trim(),
        status: 'reported',
        reportedAt: nowStr(),
        confirmedAt: null,
        clearedAt: null
      }
      this.blockages.unshift(rb)
      if (rb.eventId) {
        const cmd = useCommandStore()
        const ev = cmd.events.find((e) => e.id === rb.eventId)
        if (ev) {
          ev.timeline.push({
            at: rb.reportedAt,
            text: `🚧 现场上报道路阻断「${rb.roadName}」（${this._reasonLabel(rb.reason)}，封闭带宽约 ${radius}m，上报人：${rb.reporter}），待指挥员确认`
          })
        }
      }
      return { ok: true, blockage: rb }
    },

    /* ---------- 指挥员确认 ---------- */
    // 确认封路：仅状态流转 + 时间线；影响的物资派发/转移批次由 analyze 实时研判
    confirm(id) {
      const rb = this.blockages.find((x) => x.id === id)
      if (!rb || rb.status !== 'reported') return { ok: false, msg: '阻断记录不存在或已处理' }
      rb.status = 'active'
      rb.confirmedAt = nowStr()
      this._log(rb, `🚧 指挥员确认封路「${rb.roadName}」，等待制定绕行/改派方案`)
      return { ok: true }
    },

    // 误报撤销
    dismiss(id) {
      const rb = this.blockages.find((x) => x.id === id)
      if (!rb || (rb.status !== 'reported' && rb.status !== 'active')) return { ok: false, msg: '当前状态不可撤销' }
      rb.status = 'dismissed'
      this._log(rb, `🚫「${rb.roadName}」经核实为误报，已撤销封路`)
      return { ok: true }
    },

    /* ---------- 影响分析：物资派发 + 转移批次 ---------- */
    // 返回受当前生效阻断影响的任务清单及可执行方案（detour / reassign / suspend）
    analyze() {
      const cmd = useCommandStore()
      const tr = useTransferStore()
      const blocks = this.effectiveBlockages
      if (!blocks.length) return []
      const items = []

      cmd.dispatches.forEach((d) => {
        if (d.routeStatus === 'suspended') {
          // 已挂起：仍在清单内，便于恢复通行前调整方案
          if (d.suspendBy && d.suspendBy.every((id) => {
            const b = this.blockages.find((x) => x.id === id)
            return b && b.status === 'cleared'
          })) return
        }
        const route = this._dispatchRoute(d)
        const hits = blocks.filter((rb) => routeHitBlockage(route, rb))
        if (!hits.length) return
        const target = this._dispatchTarget(d)
        items.push({
          key: 'd-' + d.id, kind: 'dispatch', ref: d,
          title: `${d.typeLabel} ${d.qty}${d.unit}`,
          origin: d.baseName, dest: target.name,
          route, hitIds: hits.map((x) => x.id),
          targetInside: pointInBlockages([target.lng, target.lat], blocks),
          originInside: pointInBlockages([...this._dispatchOrigin(d)], blocks),
          options: this._dispatchOptions(d, route, blocks)
        })
      })

      tr.batches.forEach((b) => {
        if (b.status === 'closed') return
        const route = this._batchRoute(b)
        const hits = blocks.filter((rb) => routeHitBlockage(route, rb))
        const wasSuspended = b.routeStatus === 'suspended'
        if (!hits.length) return
        const ev = cmd.events.find((e) => e.id === b.eventId)
        const sh = tr.shelters.find((s) => s.id === b.shelterId)
        if (!ev || !sh) return
        const hasCheckin = b.members.some((x) => x.checkinAt && !x.checkoutAt)
        items.push({
          key: 'b-' + b.id, kind: 'batch', ref: b,
          title: `批次「${b.name}」${b.headcount}人`,
          origin: ev.location.name, dest: sh.name,
          route, hitIds: hits.map((x) => x.id),
          targetInside: pointInBlockages([sh.lng, sh.lat], blocks),
          originInside: pointInBlockages([ev.location.lng, ev.location.lat], blocks),
          hasCheckin,
          options: this._batchOptions(b, route, blocks, hasCheckin)
        })
      })

      // 默认建议：可绕行→绕行，否则可改派→改派，否则挂起
      items.forEach((it) => {
        it.action = it.options.detour ? 'detour' : (it.options.reassign ? 'reassign' : 'suspend')
      })
      return items
    },

    _dispatchOptions(d, route, blocks) {
      return {
        detour: this._buildDetour(route, blocks, blocks),
        reassign: this._reassignDispatch(d, blocks)
      }
    },
    _batchOptions(b, route, blocks, hasCheckin) {
      // 转移批次不改线（群众已在车上的路线改道风险高），且已入住后安置点不可改 → 仅挂起
      return {
        detour: null,
        reassign: hasCheckin ? null : this._reassignBatch(b, blocks)
      }
    },

    // 生成绕行路线：取路线进出阻断带的两个交点，沿阻断段法向双侧外移形成绕行走廊
    _buildDetour(route, hitBlocks, allBlocks) {
      if (route.length < 2) return null
      if (pointInBlockages(route[0], allBlocks) || pointInBlockages(route[route.length - 1], allBlocks)) {
        return null // 起点/终点在封闭带内，绕行无路
      }
      // 收集路线与所有命中阻断段的交点（沿路线参数 t 排序），取最外两个
      const crossings = []
      for (let i = 0; i < route.length - 1; i++) {
        const a = route[i], b = route[i + 1]
        const vx = b[0] - a[0], vy = b[1] - a[1]
        const vl = Math.hypot(vx, vy) || 1
        const dir = { x: vx / vl, y: vy / vl, tBase: i }
        hitBlocks.forEach((rb) => {
          for (let j = 0; j < rb.path.length - 1; j++) {
            const c = rb.path[j], d = rb.path[j + 1]
            const ip = intersectionPoint(a, b, c, d)
            if (ip) crossings.push({ p: ip, t: i + Math.hypot(ip[0] - a[0], ip[1] - a[1]) / vl, dir })
            // 路线段端点落在缓冲带内：以接触点代替交点
            ;[a, b].forEach((ep) => {
              if (pointSegmentDistanceM(ep, c, d) < rb.radius) {
                const t = ep === a ? i : i + 1
                if (!crossings.some((x) => Math.abs(x.t - t) < 1e-6)) {
                  crossings.push({ p: ep, t, dir })
                }
              }
            })
          }
        })
      }
      if (!crossings.length) return null
      crossings.sort((u, v) => u.t - v.t)
      const enter = crossings[0]
      const exit = crossings[crossings.length - 1]
      const margin = DETOUR_MARGIN
      // 法向（路线方向左转 90°），按距离梯度逐级外扩、左右两侧尝试
      const px0 = -enter.dir.y, py0 = enter.dir.x
      for (const dist of DETOUR_DISTANCES) {
        for (const side of DETOUR_SIDES) {
          const off = dist + margin
          const inP = offsetPointM(enter.p, px0 * off * side, py0 * off * side)
          const outP = offsetPointM(exit.p, px0 * off * side, py0 * off * side)
          const points = [route[0], inP, outP, route[route.length - 1]]
          if (!routeHitAny(points, allBlocks)) {
            return { points, distance: this._routeDistance(points), minutes: this._routeMinutes(points) }
          }
        }
      }
      return null
    },

    // 改派物资：找原基地之外、有库存且路线不被阻断的基地（按到达时长升序）
    _reassignDispatch(d, blocks) {
      const cmd = useCommandStore()
      const target = this._dispatchTarget(d)
      const cands = []
      cmd.bases.forEach((base) => {
        if (base.id === d.baseId) return
        if ((base.stock[d.type] || 0) < d.qty) return
        const p = [base.lng, base.lat]
        if (pointInBlockages(p, blocks)) return
        const route = [p, [target.lng, target.lat]]
        if (routeHitAny(route, blocks)) return
        cands.push({ base, path: roughPath(base.lng, base.lat, target.lng, target.lat) })
      })
      cands.sort((x, y) => x.path.minutes - y.path.minutes)
      return cands[0] ? { baseId: cands[0].base.id, baseName: cands[0].base.name, distance: cands[0].path.distance, minutes: cands[0].path.minutes } : null
    },

    // 改派转移批次：换安置点（床位充足、路线不被阻断；沿用车辆来源）
    _reassignBatch(b, blocks) {
      const cmd = useCommandStore()
      const tr = useTransferStore()
      const ev = cmd.events.find((e) => e.id === b.eventId)
      if (!ev) return null
      const cands = []
      tr.shelters.forEach((s) => {
        if (s.id === b.shelterId) return
        if (pointInBlockages([s.lng, s.lat], blocks)) return
        // 可用床位 = 剩余 + 该批次自身在原安置点的预占（改派后释放）
        const bed = tr.bedMap[s.id]
        let avail = bed.left
        if (s.id === b.shelterId) avail += b.headcount
        if (avail < b.headcount) return
        const route = [[ev.location.lng, ev.location.lat], [s.lng, s.lat]]
        if (routeHitAny(route, blocks)) return
        cands.push({ s, path: roughPath(ev.location.lng, ev.location.lat, s.lng, s.lat) })
      })
      cands.sort((x, y) => x.path.minutes - y.path.minutes)
      return cands[0] ? { shelterId: cands[0].s.id, shelterName: cands[0].s.name, distance: cands[0].path.distance, minutes: cands[0].path.minutes } : null
    },

    /* ---------- 执行处置方案 ---------- */
    // decisions: [{ key, action }]，action ∈ detour / reassign / suspend
    execute(decisions) {
      const result = { detour: 0, reassign: 0, suspended: 0, failed: [] }
      const analysis = this.analyze()
      const byKey = Object.fromEntries(analysis.map((it) => [it.key, it]))
      decisions.forEach(({ key, action }) => {
        const it = byKey[key]
        if (!it) return
        if (it.kind === 'dispatch') {
          if (action === 'detour') {
            const opt = action === 'detour' ? it.options.detour : null
            if (!opt) { result.failed.push(`${it.title}：无可行绕行`); return }
            this._applyDispatchDetour(it.ref, opt, it.hitIds)
            result.detour++
          } else if (action === 'reassign') {
            if (!it.options.reassign) { result.failed.push(`${it.title}：无可用改派基地`); return }
            this._applyDispatchReassign(it.ref, it.options.reassign, it.hitIds)
            result.reassign++
          } else {
            this._suspendDispatch(it.ref, it.hitIds)
            result.suspended++
          }
        } else {
          if (action === 'reassign') {
            if (!it.options.reassign) { result.failed.push(`${it.title}：无可用安置点`); return }
            this._applyBatchReassign(it.ref, it.options.reassign, it.hitIds)
            result.reassign++
          } else {
            this._suspendBatch(it.ref, it.hitIds)
            result.suspended++
          }
        }
      })
      return result
    },

    _applyDispatchDetour(d, opt, hitIds) {
      const wasSuspended = d.routeStatus === 'suspended'
      d.originalRoute = d.originalRoute || this._dispatchRoute(d)
      d.routePoints = opt.points.map((p) => [...p])
      d.distance = opt.distance
      d.minutes = opt.minutes
      d.routeStatus = 'rerouted'
      d.actionType = 'detour'
      d.blockedBy = hitIds
      d.suspendBy = null
      d.suspendSnapshot = null
      d.routeAt = nowStr()
      this._dispatchLog(d, `🛣️ 道路阻断，物资绕行：路线已更新，预计 ${opt.distance}km · ${opt.minutes}min 到达${wasSuspended ? '（挂起后续派）' : ''}`)
    },

    _applyDispatchReassign(d, opt, hitIds) {
      const cmd = useCommandStore()
      const newBase = cmd.bases.find((x) => x.id === opt.baseId)
      if (!newBase || (newBase.stock[d.type] || 0) < d.qty) return
      const wasSuspended = d.routeStatus === 'suspended'
      d.originalRoute = d.originalRoute || this._dispatchRoute(d)
      if (d.originalBaseId == null) d.originalBaseId = d.baseId
      // 库存随任务改派：原基地退还，新基地扣减
      const oldBase = cmd.bases.find((x) => x.id === d.baseId)
      if (oldBase) oldBase.stock[d.type] = (oldBase.stock[d.type] || 0) + d.qty
      newBase.stock[d.type] -= d.qty
      d.baseId = newBase.id
      d.baseName = newBase.name
      d.routePoints = null
      const p = roughPath(newBase.lng, newBase.lat, d.lng, d.lat)
      d.distance = p.distance
      d.minutes = p.minutes
      d.routeStatus = 'rerouted'
      d.actionType = 'reassign'
      d.blockedBy = hitIds
      d.suspendBy = null
      d.suspendSnapshot = null
      d.routeAt = nowStr()
      this._dispatchLog(d, `🔀 道路阻断，物资改派至${newBase.name}：预计 ${d.distance}km · ${d.minutes}min 到达，库存已同步${wasSuspended ? '（挂起后续派）' : ''}`)
    },

    _suspendDispatch(d, hitIds) {
      if (d.routeStatus !== 'suspended') {
        d.originalRoute = d.originalRoute || this._dispatchRoute(d)
        d.suspendSnapshot = {
          baseId: d.baseId, baseName: d.baseName,
          distance: d.distance, minutes: d.minutes,
          routePoints: d.routePoints ? d.routePoints.map((p) => [...p]) : null,
          routeStatus: d.routeStatus || 'normal',
          actionType: d.actionType || null
        }
      }
      d.routeStatus = 'suspended'
      d.suspendBy = Array.from(new Set([...(d.suspendBy || []), ...hitIds]))
      d.suspendedAt = nowStr()
      this._dispatchLog(d, `⏸️ 无路可走，物资任务挂起（车辆/物资原地待命），恢复通行后自动续派`)
    },

    _applyBatchReassign(b, opt, hitIds) {
      const cmd = useCommandStore()
      const tr = useTransferStore()
      const target = tr.shelters.find((s) => s.id === opt.shelterId)
      if (!target) return
      const wasSuspended = b.routeStatus === 'suspended'
      b.originalRoute = b.originalRoute || this._batchRoute(b)
      if (b.originalShelterId == null) b.originalShelterId = b.shelterId
      const old = tr.shelters.find((s) => s.id === b.shelterId)
      b.shelterId = target.id
      b.routeWaypoints = null
      b.routeStatus = 'rerouted'
      b.actionType = 'reassign'
      b.blockedBy = hitIds
      b.suspendBy = null
      b.suspendSnapshot = null
      b.routeAt = nowStr()
      const ev = cmd.events.find((e) => e.id === b.eventId)
      ev?.timeline.push({
        at: nowStr(),
        text: `🔀 道路阻断，批次「${b.name}」改派安置点：${old?.name || '原安置点'} → ${target.name}（余床位 ${tr.bedMap[target.id].left}），床位预占已同步${wasSuspended ? '，挂起后续派' : ''}`
      })
    },

    _suspendBatch(b, hitIds) {
      const cmd = useCommandStore()
      if (b.routeStatus !== 'suspended') {
        b.originalRoute = b.originalRoute || this._batchRoute(b)
        b.suspendSnapshot = {
          shelterId: b.shelterId,
          routeWaypoints: b.routeWaypoints ? b.routeWaypoints.map((p) => [...p]) : null,
          routeStatus: b.routeStatus || 'normal',
          actionType: b.actionType || null
        }
      }
      b.routeStatus = 'suspended'
      b.suspendBy = Array.from(new Set([...(b.suspendBy || []), ...hitIds]))
      b.suspendedAt = nowStr()
      const ev = cmd.events.find((e) => e.id === b.eventId)
      ev?.timeline.push({ at: nowStr(), text: `⏸️ 无路可走，批次「${b.name}」挂起（车辆 ${b.vehicleCount} 辆与床位预占保留），恢复通行后自动续派` })
    },

    /* ---------- 恢复通行：自动续派 ---------- */
    clear(id) {
      const rb = this.blockages.find((x) => x.id === id)
      if (!rb || (rb.status !== 'active' && rb.status !== 'reported')) return { ok: false, msg: '阻断记录状态不可恢复' }
      rb.status = 'cleared'
      rb.clearedAt = nowStr()
      this._log(rb, `🟢「${rb.roadName}」抢通恢复通行，挂起任务自动续派`)
      const resumed = this._autoResume()
      return { ok: true, ...resumed }
    },

    // 扫描所有挂起任务：导致其挂起的阻断全部清除且现有路线可达 → 续派；仍被其他封路阻挡则保持挂起
    _autoResume() {
      const cmd = useCommandStore()
      const tr = useTransferStore()
      const blocks = this.activeBlockages
      let resumed = 0, stillBlocked = 0

      cmd.dispatches.filter((d) => d.routeStatus === 'suspended').forEach((d) => {
        const route = this._dispatchRoute(d)
        if (routeHitAny(route, blocks)) { stillBlocked++; return }
        d.routeStatus = d.suspendSnapshot?.routeStatus === 'rerouted' ? 'rerouted' : 'normal'
        d.actionType = d.suspendSnapshot?.actionType || null
        d.suspendBy = null
        d.suspendSnapshot = null
        d.routeAt = nowStr()
        resumed++
        this._dispatchLog(d, `▶️ 道路恢复，任务续派：按当前路线预计 ${d.distance}km · ${d.minutes}min 到达`)
      })

      tr.batches.filter((b) => b.status !== 'closed' && b.routeStatus === 'suspended').forEach((b) => {
        const route = this._batchRoute(b)
        if (routeHitAny(route, blocks)) { stillBlocked++; return }
        b.routeStatus = b.suspendSnapshot?.routeStatus === 'rerouted' ? 'rerouted' : 'normal'
        b.actionType = b.suspendSnapshot?.actionType || null
        b.suspendBy = null
        b.suspendSnapshot = null
        b.routeAt = nowStr()
        resumed++
        const ev = cmd.events.find((e) => e.id === b.eventId)
        ev?.timeline.push({ at: nowStr(), text: `▶️ 道路恢复，批次「${b.name}」续派前往当前安置点` })
      })

      return { resumed, stillBlocked }
    },

    // 已改线任务恢复原线（原路线已无阻断时可用）
    restoreRoute(key) {
      const cmd = useCommandStore()
      const tr = useTransferStore()
      const blocks = this.activeBlockages
      if (key.startsWith('d-')) {
        const d = cmd.dispatches.find((x) => x.id === key.slice(2))
        if (!d || d.routeStatus !== 'rerouted' || !d.originalRoute) return { ok: false, msg: '无可恢复的原方案' }
        if (routeHitAny(d.originalRoute, blocks)) return { ok: false, msg: '原路线仍有阻断，暂不能恢复' }
        if (d.originalBaseId && d.originalBaseId !== d.baseId) {
          const cur = cmd.bases.find((x) => x.id === d.baseId)
          const orig = cmd.bases.find((x) => x.id === d.originalBaseId)
          if (!orig || (orig.stock[d.type] || 0) < d.qty) return { ok: false, msg: '原基地库存不足，无法恢复' }
          if (cur) cur.stock[d.type] = (cur.stock[d.type] || 0) + d.qty
          orig.stock[d.type] -= d.qty
          d.baseId = orig.id; d.baseName = orig.name
        }
        const p = roughPath(d.originalRoute[0][0], d.originalRoute[0][1], d.originalRoute[1][0], d.originalRoute[1][1])
        d.distance = p.distance; d.minutes = p.minutes
        d.routePoints = null
        d.routeStatus = 'normal'; d.actionType = null
        d.originalRoute = null; d.originalBaseId = null
        d.routeAt = nowStr()
        this._dispatchLog(d, '↩️ 阻断解除，物资恢复原派发路线与基地')
        return { ok: true }
      }
      const b = tr.batches.find((x) => x.id === key.slice(2))
      if (!b || b.routeStatus !== 'rerouted' || !b.originalRoute) return { ok: false, msg: '无可恢复的原方案' }
      if (routeHitAny(b.originalRoute, blocks)) return { ok: false, msg: '原路线仍有阻断，暂不能恢复' }
      const origShelter = b.originalShelterId
      if (origShelter && origShelter !== b.shelterId) {
        const avail = tr.bedMap[origShelter].left + (b.originalShelterId === b.shelterId ? b.headcount : 0)
        if (avail < b.headcount) return { ok: false, msg: '原安置点床位不足，无法恢复' }
        const old = tr.shelters.find((s) => s.id === b.shelterId)
        const target = tr.shelters.find((s) => s.id === origShelter)
        b.shelterId = origShelter
        const ev = cmd.events.find((e) => e.id === b.eventId)
        ev?.timeline.push({ at: nowStr(), text: `↩️ 批次「${b.name}」恢复原安置点：${old?.name} → ${target?.name}` })
      }
      b.routeWaypoints = null
      b.routeStatus = 'normal'; b.actionType = null
      b.originalRoute = null; b.originalShelterId = null
      b.routeAt = nowStr()
      return { ok: true }
    },

    /* ---------- 路线 / 坐标辅助 ---------- */
    _dispatchOrigin(d) {
      const cmd = useCommandStore()
      const base = cmd.bases.find((b) => b.id === d.baseId)
      return base ? [base.lng, base.lat] : [0, 0]
    },
    _dispatchTarget(d) {
      const tr = useTransferStore()
      if (d.shelterId) {
        const s = tr.shelters.find((x) => x.id === d.shelterId)
        if (s) return { name: s.name, lng: s.lng, lat: s.lat }
      }
      const cmd = useCommandStore()
      const ev = cmd.events.find((e) => e.id === d.eventId)
      return { name: ev?.title || d.eventTitle || '受灾点', lng: d.lng, lat: d.lat }
    },
    _dispatchRoute(d) {
      if (Array.isArray(d.routePoints) && d.routePoints.length >= 2) {
        return d.routePoints.map((p) => [p[0], p[1]])
      }
      return [this._dispatchOrigin(d), [d.lng, d.lat]]
    },
    _batchRoute(b) {
      if (Array.isArray(b.routeWaypoints) && b.routeWaypoints.length >= 2) {
        return b.routeWaypoints.map((p) => [p[0], p[1]])
      }
      const cmd = useCommandStore()
      const tr = useTransferStore()
      const ev = cmd.events.find((e) => e.id === b.eventId)
      const sh = tr.shelters.find((s) => s.id === b.shelterId)
      if (!ev || !sh) return []
      return [[ev.location.lng, ev.location.lat], [sh.lng, sh.lat]]
    },
    _routeDistance(points) {
      let total = 0
      for (let i = 0; i < points.length - 1; i++) {
        total += roughPath(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]).distance
      }
      return Math.round(total * 10) / 10
    },
    _routeMinutes(points) {
      let total = 0
      for (let i = 0; i < points.length - 1; i++) {
        total += roughPath(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]).minutes
      }
      // 多段路只计一次装卸常数（roughPath 每段 +8min），折回
      total -= (points.length - 2) * 8
      return Math.max(1, Math.round(total))
    },

    _dispatchLog(d, text) {
      if (!d.eventId) return // 安置点补给不挂事件时间线
      const cmd = useCommandStore()
      const ev = cmd.events.find((e) => e.id === d.eventId)
      ev?.timeline.push({ at: nowStr(), text })
    },
    _log(rb, text) {
      if (!rb.eventId) return
      const cmd = useCommandStore()
      const ev = cmd.events.find((e) => e.id === rb.eventId)
      ev?.timeline.push({ at: nowStr(), text })
    },
    _reasonLabel(v) {
      return BLOCKAGE_REASONS.find((x) => x.value === v)?.label || '道路封闭'
    }
  }
})
