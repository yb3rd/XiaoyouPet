import * as THREE from "three"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm"
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from "@pixiv/three-vrm-animation"
import { invoke, convertFileSrc } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"

const appWindow = getCurrentWindow()

const canvas = document.getElementById("view")
const bubble = document.getElementById("bubble")
const choices = document.getElementById("choices")
const composer = document.getElementById("composer")
const promptInput = document.getElementById("prompt")
const sendButton = document.getElementById("send")
const settings = document.getElementById("settings")
const ddMode = document.getElementById("dd-mode")
const ddModel = document.getElementById("dd-model")
const ddVoice = document.getElementById("dd-voice")
const ddRate = document.getElementById("dd-rate")
const ddPitch = document.getElementById("dd-pitch")
const ddTalk = document.getElementById("dd-talk")
const ddScale = document.getElementById("dd-scale")
const settingsClickThrough = document.getElementById("settings-clickThrough")
const settingsHint = document.getElementById("settings-hint")
const menu = document.getElementById("menu")
const menuScroll = document.querySelector("#menu .menu-scroll")
const menuModelList = document.getElementById("model-list")
const menuAnimList = document.getElementById("anim-list")
const newsMore = document.getElementById("news-more")
const newsDetail = document.getElementById("news-detail")
const newsList = document.getElementById("news-list")
const newsTitle = document.getElementById("news-title")

const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(canvas.clientWidth, canvas.clientHeight, false)
renderer.setClearColor(0x000000, 0)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(28, canvas.clientWidth / canvas.clientHeight, 0.1, 20)

let frameTargetX = 0
let frameTargetY = 0.9
let frameTargetZ = 3.75
let frameBaseZ = 3.75
const savedViewScale = Number(localStorage.getItem("pet.scale"))
let viewScale =
  Number.isFinite(savedViewScale) && savedViewScale >= 0.8 && savedViewScale <= 4.9
    ? savedViewScale
    : 1
let windowScale = Math.max(1, viewScale)
let cameraScale = Math.min(1, viewScale)
let frameLookX = 0
let frameLookY = 0.9
let frameCheckAt = 0

function applyCanvasScale() {
  windowScale = Math.max(1, viewScale)
  cameraScale = Math.min(1, viewScale)
  canvas.style.width = `${260 * windowScale}px`
  canvas.style.height = `${340 * windowScale}px`
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false)
  camera.aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight)
  camera.updateProjectionMatrix()
  frameCheckAt = 0
}

async function applyWindowScale(value) {
  const requested = Number(value)
  const safe = Number.isFinite(requested)
    ? Math.min(4.9, Math.max(0.8, requested))
    : 1
  const result = await invoke("set_window_scale", { scale: safe }).catch(() => null)
  const actual = Number(result?.actual)
  viewScale = Number.isFinite(actual) ? actual : safe
  applyCanvasScale()
  if (result?.ok && Math.abs(actual - safe) > 0.01) {
    settingsHint.textContent = `屏幕限制：实际 ${Math.round(actual * 100)}%`
  } else {
    settingsHint.textContent = `缩放：${Math.round(viewScale * 100)}%`
  }
}
const frameBox = new THREE.Box3()
const framePos = new THREE.Vector3()
const frameSize = new THREE.Vector3()
const frameCenter = new THREE.Vector3()
const frameBones = [
  "head",
  "hips",
  "chest",
  "leftHand",
  "rightHand",
  "leftFoot",
  "rightFoot",
  "leftUpperLeg",
  "rightUpperLeg",
]

function updateAutoFrame(time) {
  if (!vrm) return
  if (time - frameCheckAt > 0.2) {
    frameCheckAt = time
    frameBox.makeEmpty()
    let count = 0
    for (const name of frameBones) {
      const node = vrm.humanoid?.getNormalizedBoneNode(name)
      if (!node) continue
      node.getWorldPosition(framePos)
      frameBox.expandByPoint(framePos)
      count += 1
    }
    if (count >= 3) {
      frameBox.getSize(frameSize)
      frameBox.getCenter(frameCenter)
      const fov = THREE.MathUtils.degToRad(camera.fov)
      const tan = Math.tan(fov / 2)
      const vertical = (frameSize.y * 1.35) / (2 * tan)
      const horizontal = (frameSize.x * 1.35) / (2 * tan * Math.max(camera.aspect, 0.2))
      frameTargetX = frameCenter.x
      frameTargetY = frameCenter.y
      const minDistance = Math.max(frameBaseZ, vrmHeight * 1.75)
      const distance = Math.max(
        vertical,
        horizontal,
        minDistance,
        frameSize.z * 1.5 + 1.0,
      )
      frameTargetZ = Math.min(10, distance / cameraScale)
    }
  }
  camera.position.x += (frameTargetX - camera.position.x) * 0.08
  camera.position.y += (frameTargetY - camera.position.y) * 0.08
  camera.position.z += (frameTargetZ - camera.position.z) * 0.08
  frameLookX += (frameTargetX - frameLookX) * 0.08
  frameLookY += (frameTargetY - frameLookY) * 0.08
}

scene.add(new THREE.AmbientLight(0xffffff, 1.5))
const keyLight = new THREE.DirectionalLight(0xffffff, 2.2)
keyLight.position.set(1.2, 2.4, 2.2)
scene.add(keyLight)
const rimLight = new THREE.DirectionalLight(0x7aa2ff, 1.1)
rimLight.position.set(-2, 1.2, -1.8)
scene.add(rimLight)

const loader = new GLTFLoader()
loader.register((parser) => new VRMLoaderPlugin(parser))
loader.register((parser) => new VRMAnimationLoaderPlugin(parser))

let vrm = null
let mixer = null
let defaultIdleUrl = ""
let animationToken = 0
let animationLoadChain = Promise.resolve()
let vrmHeight = 1.5
let armSign = 1
let baseYaw = 0
const restRotations = new Map()

async function loadModel(url) {
  const gltf = await loader.loadAsync(url)
  const next = gltf.userData.vrm
  if (!next) throw new Error("VRM not found")

  if (mixer) {
    mixer.stopAllAction()
    mixer = null
  }
  if (vrm) {
    scene.remove(vrm.scene)
    try {
      VRMUtils.deepDispose(vrm.scene)
    } catch {}
    vrm = null
  }
  restRotations.clear()

  vrm = next
  VRMUtils.rotateVRM0(vrm)
  armSign = vrm.meta?.metaVersion === "0" ? -1 : 1
  baseYaw = armSign < 0 ? Math.PI : 0
  vrm.scene.rotation.y = baseYaw
  scene.add(vrm.scene)
  console.log(`VRM meta=${vrm.meta?.metaVersion ?? "?"} armSign=${armSign} bones=${vrm.humanoid ? "yes" : "no"}`)

  const box = new THREE.Box3().setFromObject(vrm.scene)
  const size = box.getSize(new THREE.Vector3())
  const height = size.y || 1.5
  vrmHeight = height
  frameBaseZ = height * 2.6
  const minY = box.min.y || 0

  const initialZ = Math.max(0.9, (height * 2.4) / cameraScale)
  camera.position.set(0, minY + height * 0.58, initialZ)
  camera.lookAt(0, minY + height * 0.58, 0)
  camera.updateProjectionMatrix()
  frameTargetX = 0
  frameTargetY = minY + height * 0.58
  frameTargetZ = initialZ
  frameLookX = 0
  frameLookY = frameTargetY
  frameCheckAt = 0

  vrm.scene.traverse((object) => {
    if (object.isMesh) object.frustumCulled = false
  })

  for (const name of ["head", "rightUpperArm", "leftUpperArm", "rightLowerArm", "leftLowerArm", "leftUpperLeg", "rightUpperLeg"]) {
    const node = vrm.humanoid?.getNormalizedBoneNode(name)
    if (node) restRotations.set(name, node.rotation.clone())
  }

  console.log(`VRM loaded: ${url}`)
  if (defaultIdleUrl) void playAnimation(defaultIdleUrl)
}

function loadAnimationFile(url, token) {
  const load = animationLoadChain.then(() => {
    if (token !== animationToken) return null
    return loader.loadAsync(url)
  })
  animationLoadChain = load.catch(() => {})
  return load
}

async function playAnimation(url) {
  const token = ++animationToken
  if (mixer) {
    mixer.stopAllAction()
    try {
      mixer.uncacheRoot(vrm.scene)
    } catch {}
    mixer = null
  }
  if (!url || !vrm) return null
  const gltf = await loadAnimationFile(url, token).catch(() => null)
  if (!gltf || token !== animationToken) return null
  const animations = gltf.userData.vrmAnimations
  if (!animations?.length) return null
  const clip = createVRMAnimationClip(animations[0], vrm)
  mixer = new THREE.AnimationMixer(vrm.scene)
  const action = mixer.clipAction(clip)
  // 舞蹈/待机都循环播放；只有 stopDance() 在音乐结束时才会停止
  action.setLoop(THREE.LoopRepeat, Infinity)
  action.clampWhenFinished = false
  action.play()
  return token
}

const savedModelUrl = localStorage.getItem("pet.modelUrl") || "./sample.vrm"
try {
  await loadModel(savedModelUrl)
} catch (error) {
  console.error("VRM load failed", error)
  if (savedModelUrl !== "./sample.vrm") {
    await loadModel("./sample.vrm").catch(() => {})
  }
}

const talkModeOptions = [
  { value: "off", label: "关闭" },
  { value: "normal", label: "普通（3–7 分钟）" },
  { value: "frequent", label: "经常（1–2 分钟）" },
  { value: "very", label: "很频繁（30–60 秒）" },
]

const talkModeIntervals = {
  normal: [180000, 420000],
  frequent: [60000, 120000],
  very: [30000, 60000],
}

const savedTalkMode = localStorage.getItem("pet.talkMode")
let talkMode = talkModeOptions.some((item) => item.value === savedTalkMode) ? savedTalkMode : "frequent"
let talkDropdown = null
let talkBusy = false
let nextTalk = 0
let nextAnim = performance.now() + 25000
let animationUrls = []

function talkModeLabel(value) {
  return talkModeOptions.find((item) => item.value === value)?.label || "经常"
}

function scheduleNextTalk(delay) {
  if (talkMode === "off") {
    nextTalk = Infinity
    return
  }
  const [min, max] = talkModeIntervals[talkMode] || talkModeIntervals.frequent
  nextTalk = performance.now() + (Number.isFinite(delay) ? delay : min + Math.random() * (max - min))
}

function setTalkMode(value, announce = false) {
  talkMode = talkModeOptions.some((item) => item.value === value) ? value : "frequent"
  localStorage.setItem("pet.talkMode", talkMode)
  talkDropdown?.setValue(talkMode)
  refreshMenu()
  scheduleNextTalk()
  if (announce) {
    showBubble(talkMode === "off" ? "主动聊天已关闭" : `主动聊天：${talkModeLabel(talkMode)}`)
  }
}

function cycleTalkMode() {
  const values = talkModeOptions.map((item) => item.value)
  const index = values.indexOf(talkMode)
  setTalkMode(values[(index + 1) % values.length], true)
}

function autoTalkBlocked() {
  return (
    talkBusy ||
    speaking ||
    dancing ||
    singing ||
    !composer.classList.contains("hidden") ||
    !settings.classList.contains("hidden") ||
    !newsDetail.classList.contains("hidden") ||
    !choices.classList.contains("hidden")
  )
}

scheduleNextTalk(25000 + Math.random() * 20000)

let speaking = false
let lastText = ""
let hiddenAt = 0
let nextBlink = 2
let blinkUntil = 0
let mouthTimer = 0
let mouthIndex = 0
const visemes = ["aa", "ih", "ou", "ee", "oh"]


function addBoneRotation(name, x, y, z) {
  const node = vrm?.humanoid?.getNormalizedBoneNode(name)
  const rest = restRotations.get(name)
  if (!node || !rest) return
  const flip = name === "rightUpperArm" || name === "leftUpperArm" ? armSign : 1
  node.rotation.set(rest.x + x, rest.y + y, rest.z + z * flip)
}

function cleanText(text) {
  return text
    .replace(/```[\s\S]*?```/g, "（代码略）")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[*_>~|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function showBubble(text) {
  bubble.textContent = text
  bubble.classList.remove("hidden")
  hiddenAt = performance.now() + 20000
  newsMore.classList.add("hidden")
  hideChoices()
}

let newsData = { title: "", items: [] }

function showNewsButton(items, title) {
  newsData = { title: title || "新闻详情", items: Array.isArray(items) ? items : [] }
  if (!newsData.items.length) return
  newsMore.classList.remove("hidden")
}

function openNewsDetail() {
  if (!newsData.items.length) return
  newsTitle.textContent = newsData.title || "新闻详情"
  newsList.innerHTML = ""
  for (const item of newsData.items) {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "news-item"
    const title = document.createElement("span")
    title.className = "news-item-title"
    title.textContent = item.title || ""
    const meta = document.createElement("span")
    meta.className = "news-item-meta"
    meta.textContent = [item.source, item.meta].filter(Boolean).join(" · ")
    button.append(title, meta)
    if (item.url) {
      button.addEventListener("click", () => void invoke("open_url", { url: item.url }))
    } else {
      button.disabled = true
    }
    newsList.append(button)
  }
  newsDetail.classList.remove("hidden")
  newsMore.classList.add("hidden")
}

function closeNewsDetail() {
  newsDetail.classList.add("hidden")
}

newsMore.addEventListener("click", (event) => {
  event.stopPropagation()
  openNewsDetail()
})

const choiceQuestions = [
  {
    text: "今天心情怎么样呀？",
    options: [
      { label: "开心", send: "我今天心情很好" },
      { label: "一般", send: "我今天心情一般" },
      { label: "有点累", send: "我今天有点累" },
    ],
  },
  {
    text: "你现在在忙什么？",
    options: [
      { label: "工作", send: "我正在忙工作" },
      { label: "学习", send: "我正在学习" },
      { label: "摸鱼", send: "我正在摸鱼" },
    ],
  },
  {
    text: "中午想吃点什么？",
    slots: ["noon"],
    options: [
      { label: "外卖", send: "中午想点外卖" },
      { label: "自己做", send: "中午想自己做饭" },
      { label: "随便", send: "中午吃什么都行" },
    ],
  },
  {
    text: "晚饭有想好吗？",
    slots: ["evening"],
    options: [
      { label: "还没想", send: "晚饭还没想好吃什么" },
      { label: "点外卖", send: "晚饭想点外卖" },
      { label: "自己做", send: "晚饭想自己做" },
    ],
  },
  {
    text: "周末想怎么过？",
    options: [
      { label: "宅家", send: "周末想宅在家里" },
      { label: "出去玩", send: "周末想出去玩" },
      { label: "打游戏", send: "周末想打游戏" },
    ],
  },
  {
    text: "最近在玩什么游戏？",
    options: [
      { label: "手游", send: "最近在玩手游" },
      { label: "单机", send: "最近在玩单机游戏" },
      { label: "没玩", send: "最近没怎么玩游戏" },
    ],
  },
  {
    text: "喜欢猫还是狗？",
    options: [
      { label: "猫", send: "我更喜欢猫" },
      { label: "狗", send: "我更喜欢狗" },
      { label: "都喜欢", send: "猫和狗我都喜欢" },
    ],
  },
  {
    text: "你更喜欢甜的还是辣的？",
    options: [
      { label: "甜的", send: "我更喜欢甜的" },
      { label: "辣的", send: "我更喜欢辣的" },
      { label: "都爱", send: "甜的和辣的我都喜欢" },
    ],
  },
  {
    text: "今天喝够水了吗？",
    options: [
      { label: "喝了", send: "我今天喝够水了" },
      { label: "还没", send: "我今天还没喝够水" },
      { label: "马上去", send: "我马上去喝水" },
    ],
  },
  {
    text: "昨晚睡得好吗？",
    slots: ["morning"],
    options: [
      { label: "很好", send: "我昨晚睡得很好" },
      { label: "一般", send: "我昨晚睡得一般" },
      { label: "没睡好", send: "我昨晚没睡好" },
    ],
  },
  {
    text: "现在累不累？",
    options: [
      { label: "不累", send: "我现在不累" },
      { label: "有点", send: "我现在有点累" },
      { label: "很累", send: "我现在很累" },
    ],
  },
  {
    text: "要不要我给你讲条新闻？",
    options: [
      { label: "📰 来一条", action: "news" },
      { label: "🎵 放首歌", action: "sing" },
      { label: "下次吧", send: "下次再听新闻吧" },
    ],
  },
  {
    text: "想听我唱首歌吗？",
    options: [
      { label: "🎤 唱吧", action: "sing" },
      { label: "💃 跳个舞", action: "dance" },
      { label: "安静会儿", action: "quiet" },
    ],
  },
  {
    text: "你喜欢我安静一点还是话多一点？",
    options: [
      { label: "话多点", send: "我喜欢你话多一点" },
      { label: "安静点", send: "我希望你安静一点" },
      { label: "现在这样", send: "你现在这样就很好" },
    ],
  },
  {
    text: "我这样经常找你，会不会烦到你？",
    options: [
      { label: "不会呀", send: "不会呀，我不觉得烦" },
      { label: "有点", send: "有一点点烦" },
      { label: "喜欢", send: "我挺喜欢你找我的" },
    ],
  },
  {
    text: "你希望我怎么称呼你？",
    options: [
      { label: "叫我老板", send: "以后叫我老板吧" },
      { label: "叫我哥哥", send: "以后叫我哥哥吧" },
      { label: "就叫名字", send: "还是叫我的名字吧" },
    ],
  },
  {
    text: "有什么想让我记住的吗？",
    options: [
      { label: "有", action: "compose" },
      { label: "没有", send: "暂时没有想让你记住的" },
      { label: "你猜", send: "你猜猜看" },
    ],
  },
  {
    text: "最近有在追番吗？",
    options: [
      { label: "在追", send: "我最近在追番" },
      { label: "没追", send: "我最近没追番" },
      { label: "推荐一部", send: "给我推荐一部番吧" },
    ],
  },
  {
    text: "喜欢什么颜色？",
    options: [
      { label: "蓝色", send: "我喜欢蓝色" },
      { label: "粉色", send: "我喜欢粉色" },
      { label: "黑色", send: "我喜欢黑色" },
    ],
  },
  {
    text: "今天有没有摸鱼？",
    slots: ["afternoon", "evening"],
    options: [
      { label: "摸了", send: "今天摸鱼了" },
      { label: "没有", send: "今天没有摸鱼" },
      { label: "一直在摸", send: "今天一直在摸鱼" },
    ],
  },
  {
    text: "你一般几点睡？",
    slots: ["night"],
    options: [
      { label: "早点睡", send: "我一般睡得比较早" },
      { label: "十二点", send: "我一般十二点睡" },
      { label: "熬夜", send: "我经常熬夜" },
    ],
  },
  {
    text: "早饭吃了吗？",
    slots: ["morning"],
    options: [
      { label: "吃了", send: "我吃过早饭了" },
      { label: "没吃", send: "我还没吃早饭" },
      { label: "还没起", send: "我还没起床" },
    ],
  },
  {
    text: "现在最想做什么？",
    options: [
      { label: "睡觉", send: "我现在最想睡觉" },
      { label: "玩游戏", send: "我现在最想玩游戏" },
      { label: "出门", send: "我现在最想出门走走" },
    ],
  },
  {
    text: "喜欢听什么类型的歌？",
    options: [
      { label: "流行", send: "我喜欢听流行歌" },
      { label: "二次元", send: "我喜欢听二次元歌曲" },
      { label: "纯音乐", send: "我喜欢听纯音乐" },
    ],
  },
  {
    text: "想看我跳舞吗？",
    options: [
      { label: "💃 跳吧", action: "dance" },
      { label: "🎤 唱歌", action: "sing" },
      { label: "下次", send: "下次再看你跳舞吧" },
    ],
  },
  {
    text: "你猜我现在在想什么？",
    options: [
      { label: "吃的", send: "你在想吃的吧" },
      { label: "玩的", send: "你在想玩的吧" },
      { label: "我", send: "你是在想我吧" },
    ],
  },
  {
    text: "你觉得自己是内向还是外向？",
    options: [
      { label: "内向", send: "我觉得自己比较内向" },
      { label: "外向", send: "我觉得自己比较外向" },
      { label: "看情况", send: "我内向还是外向要看情况" },
    ],
  },
  {
    text: "喜欢下雨天还是晴天？",
    options: [
      { label: "雨天", send: "我更喜欢下雨天" },
      { label: "晴天", send: "我更喜欢晴天" },
      { label: "都行", send: "下雨天和晴天我都喜欢" },
    ],
  },
  {
    text: "最近有什么开心的事吗？",
    options: [
      { label: "有", send: "最近有开心的事" },
      { label: "没有", send: "最近没什么开心的事" },
      { label: "想听你说", send: "我想听你说点开心的" },
    ],
  },
  {
    text: "最近有什么烦心事吗？",
    options: [
      { label: "有", send: "最近有烦心事" },
      { label: "还好", send: "最近还好，没什么烦心事" },
      { label: "不想说", send: "我现在不想说烦心事" },
    ],
  },
  {
    text: "更想去海边还是山上？",
    options: [
      { label: "海边", send: "我更想去海边" },
      { label: "山上", send: "我更想去山上" },
      { label: "都想去", send: "海边和山上我都想去" },
    ],
  },
  {
    text: "喜欢喝奶茶还是咖啡？",
    options: [
      { label: "奶茶", send: "我更喜欢喝奶茶" },
      { label: "咖啡", send: "我更喜欢喝咖啡" },
      { label: "都不喝", send: "奶茶和咖啡我都不怎么喝" },
    ],
  },
  {
    text: "今天有没有遇到好玩的事？",
    slots: ["afternoon", "evening"],
    options: [
      { label: "有", send: "今天遇到了好玩的事" },
      { label: "没有", send: "今天没遇到什么好玩的事" },
      { label: "你猜", send: "你猜我今天遇到好玩的事没有" },
    ],
  },
  {
    text: "你平时喜欢一个人待着吗？",
    options: [
      { label: "喜欢", send: "我平时喜欢一个人待着" },
      { label: "不喜欢", send: "我平时不太喜欢一个人待着" },
      { label: "看心情", send: "我一个人待着要看心情" },
    ],
  },
  {
    text: "要不要一起休息十分钟？",
    options: [
      { label: "好呀", send: "好呀，一起休息十分钟" },
      { label: "再聊会儿", send: "再陪我聊一会儿吧" },
      { label: "不用", send: "不用休息，我还不累" },
    ],
  },
  {
    text: "你对我第一印象怎么样？",
    options: [
      { label: "可爱", send: "你给我的第一印象很可爱" },
      { label: "话多", send: "你给我的第一印象是话有点多" },
      { label: "挺好", send: "你给我的第一印象挺好的" },
    ],
  },
  {
    text: "你觉得我可爱吗？",
    options: [
      { label: "可爱", send: "我觉得你很可爱" },
      { label: "一般", send: "我觉得你一般可爱" },
      { label: "非常可爱", send: "我觉得你非常可爱" },
    ],
  },
  {
    text: "如果放假一天，你想干嘛？",
    options: [
      { label: "睡觉", send: "放假一天我想睡觉" },
      { label: "出去玩", send: "放假一天我想出去玩" },
      { label: "打游戏", send: "放假一天我想打游戏" },
    ],
  },
  {
    text: "喜欢什么季节？",
    options: [
      { label: "春天", send: "我喜欢春天" },
      { label: "夏天", send: "我喜欢夏天" },
      { label: "秋冬", send: "我喜欢秋冬" },
    ],
  },
  {
    text: "你最近在看什么剧？",
    options: [
      { label: "在追剧", send: "我最近在追剧" },
      { label: "没看", send: "我最近没看剧" },
      { label: "推荐一部", send: "给我推荐一部剧吧" },
    ],
  },
  {
    text: "今天穿什么颜色的衣服？",
    slots: ["morning", "afternoon"],
    options: [
      { label: "深色", send: "我今天穿的是深色衣服" },
      { label: "浅色", send: "我今天穿的是浅色衣服" },
      { label: "你猜", send: "你猜我今天穿什么颜色" },
    ],
  },
  {
    text: "你更喜欢早上还是晚上？",
    options: [
      { label: "早上", send: "我更喜欢早上" },
      { label: "晚上", send: "我更喜欢晚上" },
      { label: "都行", send: "早上和晚上我都喜欢" },
    ],
  },
  {
    text: "要不要我安静陪你一会儿？",
    options: [
      { label: "好呀", action: "quiet" },
      { label: "再聊会儿", send: "再陪我聊一会儿吧" },
      { label: "不用", send: "不用啦，我现在挺好" },
    ],
  },
  {
    text: "今天有什么安排吗？",
    slots: ["morning", "afternoon"],
    options: [
      { label: "上班", send: "今天要上班" },
      { label: "学习", send: "今天要学习" },
      { label: "休息", send: "今天想休息" },
    ],
  },
  {
    text: "现在在午休吗？",
    slots: ["noon"],
    options: [
      { label: "在休息", send: "我正在午休" },
      { label: "还在忙", send: "我中午还在忙" },
      { label: "没午休", send: "我今天没午休" },
    ],
  },
  {
    text: "下午还要忙吗？",
    slots: ["afternoon"],
    options: [
      { label: "要忙", send: "下午还要忙" },
      { label: "还好", send: "下午还好，不太忙" },
      { label: "摸鱼", send: "下午准备摸鱼" },
    ],
  },
  {
    text: "今天下班了吗？",
    slots: ["evening"],
    options: [
      { label: "下班了", send: "我今天已经下班了" },
      { label: "还在加班", send: "我还在加班" },
      { label: "今天休息", send: "我今天休息" },
    ],
  },
  {
    text: "明天要早起吗？",
    slots: ["night"],
    options: [
      { label: "要早起", send: "明天要早起" },
      { label: "不用", send: "明天不用早起" },
      { label: "还没想", send: "明天起不起早还没想好" },
    ],
  },
  {
    text: "今天最开心的事是什么？",
    slots: ["evening", "night"],
    options: [
      { label: "吃到好吃的", send: "今天吃到好吃的了" },
      { label: "见到想见的人", send: "今天见到想见的人了" },
      { label: "有好玩的事", send: "今天遇到了好玩的事" },
    ],
  },
  {
    text: "最近有想买的东西吗？",
    options: [
      { label: "有", send: "最近有想买的东西" },
      { label: "没有", send: "最近没有想买的东西" },
      { label: "还没想", send: "还没想好买什么" },
    ],
  },
  {
    text: "喜欢看什么类型的电影？",
    options: [
      { label: "喜剧", send: "我喜欢看喜剧" },
      { label: "科幻", send: "我喜欢看科幻" },
      { label: "恐怖", send: "我喜欢看恐怖片" },
    ],
  },
  {
    text: "最近有想去的地方吗？",
    options: [
      { label: "海边", send: "最近想去海边" },
      { label: "山上", send: "最近想去山上" },
      { label: "家里", send: "最近只想待在家里" },
    ],
  },
  {
    text: "今天有没有听歌？",
    options: [
      { label: "听了", send: "今天听歌了" },
      { label: "没听", send: "今天还没听歌" },
      { label: "想听你唱", action: "sing" },
    ],
  },
  {
    text: "要不要我给你推荐一首歌？",
    options: [
      { label: "🎵 好呀", action: "sing" },
      { label: "下次吧", send: "下次再听你推荐歌" },
      { label: "不用", send: "不用推荐啦" },
    ],
  },
  {
    text: "你最近睡够了吗？",
    options: [
      { label: "睡够了", send: "我最近睡够了" },
      { label: "没睡够", send: "我最近没睡够" },
      { label: "一般", send: "我最近睡眠一般" },
    ],
  },
  {
    text: "有没有什么想吐槽的？",
    slots: ["evening", "night"],
    options: [
      { label: "有", send: "我有想吐槽的事" },
      { label: "没有", send: "暂时没有想吐槽的" },
      { label: "不想说", send: "我现在不想吐槽" },
    ],
  },
  {
    text: "今天过得快吗？",
    slots: ["evening"],
    options: [
      { label: "很快", send: "今天过得很快" },
      { label: "一般", send: "今天过得一般" },
      { label: "很慢", send: "今天过得很慢" },
    ],
  },
  {
    text: "最近在学什么新东西吗？",
    options: [
      { label: "在学", send: "我最近在学新东西" },
      { label: "没学", send: "我最近没学什么" },
      { label: "想学", send: "我最近想学点新东西" },
    ],
  },
  {
    text: "你喜欢一个人吃饭吗？",
    options: [
      { label: "喜欢", send: "我喜欢一个人吃饭" },
      { label: "不喜欢", send: "我不喜欢一个人吃饭" },
      { label: "看情况", send: "我一个人吃饭要看情况" },
    ],
  },
  {
    text: "最近有和朋友出去玩吗？",
    options: [
      { label: "有", send: "最近和朋友出去玩了" },
      { label: "没有", send: "最近没和朋友出去玩" },
      { label: "想出去", send: "最近想和朋友出去玩" },
    ],
  },
  {
    text: "你更喜欢计划还是随性？",
    options: [
      { label: "计划", send: "我更喜欢提前计划" },
      { label: "随性", send: "我更喜欢随性一点" },
      { label: "看情况", send: "计划还是随性要看情况" },
    ],
  },
  {
    text: "如果现在能瞬移，你想去哪？",
    options: [
      { label: "海边", send: "我想瞬移到海边" },
      { label: "家里", send: "我想瞬移回家" },
      { label: "随便", send: "随便去哪都行" },
    ],
  },
  {
    text: "今天有没有被什么逗笑？",
    options: [
      { label: "有", send: "今天有被逗笑" },
      { label: "没有", send: "今天还没被逗笑" },
      { label: "你逗我", send: "你来逗我笑吧" },
    ],
  },
  {
    text: "最近有没有想改掉的小习惯？",
    options: [
      { label: "有", send: "有想改掉的小习惯" },
      { label: "没有", send: "暂时没有想改的习惯" },
      { label: "正在改", send: "我正在改一个小习惯" },
    ],
  },
  {
    text: "你最近有没有特别想吃的东西？",
    options: [
      { label: "火锅", send: "我最近特别想吃火锅" },
      { label: "甜品", send: "我最近特别想吃甜品" },
      { label: "随便", send: "我最近吃什么都行" },
    ],
  },
  {
    text: "你喜欢安静还是热闹？",
    options: [
      { label: "安静", send: "我更喜欢安静" },
      { label: "热闹", send: "我更喜欢热闹" },
      { label: "看心情", send: "安静还是热闹要看心情" },
    ],
  },
  {
    text: "今天有没有看到好看的云？",
    options: [
      { label: "有", send: "今天看到了好看的云" },
      { label: "没注意", send: "今天没注意看云" },
      { label: "你看到了", send: "你看到好看的云了吗" },
    ],
  },
  {
    text: "最近有没有什么小目标？",
    options: [
      { label: "有", send: "我最近有小目标" },
      { label: "没有", send: "我最近没什么小目标" },
      { label: "还在想", send: "小目标还在想" },
    ],
  },
  {
    text: "你最近有没有熬夜？",
    slots: ["night"],
    options: [
      { label: "有", send: "我最近有熬夜" },
      { label: "没有", send: "我最近没熬夜" },
      { label: "偶尔", send: "我偶尔会熬夜" },
    ],
  },
  {
    text: "你最近在看什么书吗？",
    options: [
      { label: "在看", send: "我最近在看一本书" },
      { label: "没看", send: "我最近没看书" },
      { label: "推荐一本", send: "给我推荐一本书吧" },
    ],
  },
  {
    text: "你最近有没有做梦？",
    slots: ["morning"],
    options: [
      { label: "有", send: "我最近有做梦" },
      { label: "没有", send: "我最近没做梦" },
      { label: "记不清", send: "我记不清有没有做梦" },
    ],
  },
  {
    text: "现在最想听什么？",
    options: [
      { label: "你说话", send: "我现在想听你说话" },
      { label: "音乐", action: "sing" },
      { label: "安静", action: "quiet" },
    ],
  },
]


const QUESTION_HISTORY_KEY = "pet.questionHistory.v1"
const QUESTION_KEEP_MS = 60 * 24 * 60 * 60 * 1000
const QUESTION_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000
const ANSWERED_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000
const QUESTION_MIN_GAP_MS = 4 * 60 * 1000
const QUESTION_TOPIC_WINDOW_MS = 2 * 60 * 60 * 1000

function questionTopic(text) {
  if (/心情|开心|烦心|累|难过|情绪|过得|吐槽|逗笑|好玩|小目标/.test(text)) return "mood"
  if (/吃|饭|外卖|奶茶|咖啡|甜|辣|火锅|甜品|零食/.test(text)) return "food"
  if (/睡|熬夜|早起|午休|休息|做梦|喝水/.test(text)) return "rest"
  if (/周末|放假|假期|海边|山上|出去玩|想买|瞬移|地方/.test(text)) return "leisure"
  if (/游戏|番|剧|电影|书|音乐|歌/.test(text)) return "hobby"
  if (/工作|忙|加班|摸鱼|学习|上班|下班|安排/.test(text)) return "work"
  if (/颜色|季节|猫|狗|性格|内向|外向|计划|随性|安静|热闹/.test(text)) return "preference"
  return "general"
}

function loadQuestionHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(QUESTION_HISTORY_KEY) || "[]")
    if (!Array.isArray(raw)) return []
    const now = Date.now()
    return raw
      .filter((item) => item && typeof item.text === "string" && item.text.trim())
      .map((item) => ({
        text: item.text.trim().slice(0, 120),
        at: Number(item.at) || 0,
        answered: Boolean(item.answered),
        answeredAt: Number(item.answeredAt) || 0,
        topic: item.topic || questionTopic(item.text),
      }))
      .filter((item) => now - item.at < QUESTION_KEEP_MS)
      .slice(-200)
  } catch {
    return []
  }
}

let questionHistory = loadQuestionHistory()
let lastQuestionAt = questionHistory.reduce((max, item) => Math.max(max, item.at || 0), 0)
let pendingChoice = null
let lastChoiceClick = 0

function saveQuestionHistory() {
  try {
    localStorage.setItem(QUESTION_HISTORY_KEY, JSON.stringify(questionHistory.slice(-200)))
  } catch {}
}

function latestQuestionEntry(text) {
  const needle = String(text || "").trim()
  for (let index = questionHistory.length - 1; index >= 0; index--) {
    if (questionHistory[index].text === needle) return questionHistory[index]
  }
  return null
}

function markQuestionAsked(question) {
  const text = String(question?.text || "").trim()
  if (!text) return
  const now = Date.now()
  const entry = latestQuestionEntry(text)
  if (entry) {
    entry.at = now
    entry.answered = false
    entry.answeredAt = 0
    entry.topic = questionTopic(text)
  } else {
    questionHistory.push({
      text,
      at: now,
      answered: false,
      answeredAt: 0,
      topic: questionTopic(text),
    })
  }
  questionHistory = questionHistory.slice(-200)
  lastQuestionAt = now
  saveQuestionHistory()
}

function markQuestionAnswered(question) {
  const text = String(question?.text || "").trim()
  if (!text) return
  const entry = latestQuestionEntry(text)
  if (!entry) return
  entry.answered = true
  entry.answeredAt = Date.now()
  saveQuestionHistory()
}

function questionAllowed() {
  return Date.now() - lastQuestionAt >= QUESTION_MIN_GAP_MS
}

function isQuestionCoolingDown(question, now) {
  const entry = latestQuestionEntry(question.text)
  if (!entry) return false
  const cooldown = entry.answered ? ANSWERED_COOLDOWN_MS : QUESTION_COOLDOWN_MS
  return now - entry.at < cooldown
}

function recentQuestionTopics(now) {
  const topics = new Set()
  for (let index = questionHistory.length - 1; index >= 0; index--) {
    const entry = questionHistory[index]
    if (now - entry.at > QUESTION_TOPIC_WINDOW_MS) break
    topics.add(entry.topic || questionTopic(entry.text))
  }
  return topics
}

function currentTimeSlot() {
  const hour = new Date().getHours()
  if (hour < 6) return "night"
  if (hour < 11) return "morning"
  if (hour < 14) return "noon"
  if (hour < 18) return "afternoon"
  if (hour < 23) return "evening"
  return "night"
}

function nextChoiceQuestion() {
  const now = Date.now()
  const slot = currentTimeSlot()
  const recentTopics = recentQuestionTopics(now)
  const timePool = choiceQuestions.filter(
    (question) => !question.slots || question.slots.includes(slot),
  )
  const basePool = timePool.length ? timePool : choiceQuestions
  let pool = basePool.filter(
    (question) =>
      !isQuestionCoolingDown(question, now) &&
      !recentTopics.has(questionTopic(question.text)),
  )
  if (!pool.length) {
    pool = basePool.filter((question) => !isQuestionCoolingDown(question, now))
  }
  if (!pool.length) {
    pool = [...basePool]
      .sort((a, b) => {
        const aEntry = latestQuestionEntry(a.text)
        const bEntry = latestQuestionEntry(b.text)
        return (aEntry?.at || 0) - (bEntry?.at || 0)
      })
      .slice(0, 8)
  }
  return pool[Math.floor(Math.random() * pool.length)]
}

function parseDynamicQuestion(text) {
  const raw = String(text || "").replace(/```(?:json)?/gi, "").trim()
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try {
    const data = JSON.parse(raw.slice(start, end + 1))
    const question = String(data.question || "")
      .replace(/\s+/g, " ")
      .trim()
    if (!question || question.length > 50) return null
    const rawOptions = Array.isArray(data.options) ? data.options : []
    const options = []
    for (const value of rawOptions) {
      const label = String(typeof value === "string" ? value : value?.label ?? "")
        .replace(/^\s*\d+[.、)]\s*/, "")
        .trim()
      if (!label || options.some((item) => item.label === label)) continue
      options.push({ label: label.slice(0, 12), send: label })
      if (options.length >= 3) break
    }
    if (options.length < 2) return null
    return { text: question, options }
  } catch {
    return null
  }
}

function dynamicQuestionAlreadyAsked(question) {
  const needle = question.text.trim().toLowerCase()
  return questionHistory.some((item) => item.text.trim().toLowerCase() === needle)
}

async function generateDynamicQuestion() {
  const now = new Date()
  const timeText = now.toLocaleString("zh-CN", { hour12: false })
  const recentQuestions = questionHistory.slice(-12).map((item) => item.text)
  const recentTopics = [...recentQuestionTopics(Date.now())].join("、") || "无"
  const prompt = `现在是${timeText}。请像真人一样，结合长期记忆和最近对话，问用户一个自然、具体、轻松的问题，并给出3个简短回答选项。
要求：
- 不要重复最近问过的问题，也不要用同义句重复：${recentQuestions.join("；") || "无"}
- 最近聊过的话题：${recentTopics}
- 问题不超过25个字，口语化，不要像问卷调查。
- 选项是用户可能给出的回答，每个不超过8个字。
- 不要问隐私、沉重或需要长篇回答的问题。
- 只输出 JSON：{"question":"问题","options":["选项1","选项2","选项3"]}`
  talkBusy = true
  let result = null
  try {
    result = await invoke("chat", {
      text: prompt,
      history: history.slice(-6),
      model: currentModel(),
      memory: memoryNotes(),
      system: "你是桌面宠物小尤，像真人一样聊天。只输出 JSON，不要解释。",
    }).catch(() => null)
  } finally {
    talkBusy = false
  }
  if (!result?.ok || !result.text) return null
  const question = parseDynamicQuestion(result.text)
  if (!question || dynamicQuestionAlreadyAsked(question)) return null
  return question
}

function hideChoices() {
  pendingChoice = null
  choices.classList.add("hidden")
  choices.innerHTML = ""
}

function showChoices(question, options) {
  if (!options?.length) return
  pendingChoice = { question, options }
  choices.innerHTML = ""
  options.forEach((option, index) => {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "choice-btn"
    button.textContent = option.label
    button.dataset.index = String(index)
    choices.append(button)
  })
  choices.classList.remove("hidden")
  hiddenAt = performance.now() + 60000
}

function stopSpeech() {
  speechToken += 1
  if (audio) {
    audio.pause()
    audio = null
  }
  if ("speechSynthesis" in window) speechSynthesis.cancel()
  speaking = false
}

async function askChoiceQuestion(useDynamic = false) {
  let question = null
  if (useDynamic) question = await generateDynamicQuestion()
  if (!question) question = nextChoiceQuestion()
  if (!question || autoTalkBlocked()) return
  markQuestionAsked(question)
  showBubble(question.text)
  showChoices(question.text, question.options)
  speak(question.text)
}

async function runChoiceAction(action) {
  if (action === "news") {
    const kinds = ["ai-news", "world-news", "anime-news", "game-news", "acg-news"]
    showBubble("好，我去看看今天有什么新闻…")
    await autonomousTalk(false, kinds[Math.floor(Math.random() * kinds.length)])
  } else if (action === "sing") {
    await startSing()
  } else if (action === "dance") {
    await startDance()
  } else if (action === "compose") {
    openComposer()
  } else if (action === "quiet") {
    scheduleNextTalk(10 * 60 * 1000)
    showBubble("好，那我安静陪着你～")
  } else if (action === "weather") {
    await autonomousTalk(false, "weather")
  }
}

async function chooseOption(index) {
  if (!pendingChoice) return
  const { question, options } = pendingChoice
  const option = options[index]
  if (!option) return
  markQuestionAnswered(question)
  hideChoices()
  stopSpeech()
  if (option.action) {
    await runChoiceAction(option.action)
    return
  }
  await sendPrompt(option.send || option.label, question, option.label)
}

choices.addEventListener("click", (event) => {
  const button = event.target.closest(".choice-btn")
  if (!button) return
  event.stopPropagation()
  lastChoiceClick = performance.now()
  void chooseOption(Number(button.dataset.index))
})

let voiceOn = localStorage.getItem("pet.voice.v3") !== "0"

let audio = null
let speechToken = 0

async function speak(text, force = false) {
  if (!voiceOn && !force) return
  const token = ++speechToken
  const voice = localStorage.getItem("pet.voiceName") || "zh-CN-XiaoyiNeural"
  if (voice !== "system") {
    const rate = localStorage.getItem("pet.rate") || "+0%"
    const pitch = localStorage.getItem("pet.pitch") || "+0Hz"
    const result = await invoke("speak", { text, voice, rate, pitch }).catch(() => null)
    if (token !== speechToken) return
    if (!result?.ok) console.log(`[speak] failed: ${result?.error ?? "unknown"}`)
    if (result?.ok && result.audio) {
      try {
        if (audio) {
          audio.pause()
          audio = null
        }
        audio = new Audio(result.audio)
        audio.onplay = () => {
          speaking = true
        }
        audio.onended = () => {
          speaking = false
        }
        audio.onerror = () => {
          speaking = false
        }
        await audio.play()
        return
      } catch {
        speaking = false
      }
    }
  }
  speakSystem(text)
}

function speakSystem(text) {
  if (!("speechSynthesis" in window)) return
  speechSynthesis.cancel()
  speechSynthesis.resume()
  const utterance = new SpeechSynthesisUtterance(text.slice(0, 400))
  utterance.lang = "zh-CN"
  utterance.rate = 1.02
  const voices = speechSynthesis.getVoices()
  const voice = voices.find((item) => item.lang.toLowerCase().startsWith("zh"))
  if (voice) utterance.voice = voice
  utterance.onstart = () => {
    speaking = true
  }
  utterance.onend = () => {
    speaking = false
  }
  utterance.onerror = () => {
    speaking = false
  }
  speechSynthesis.speak(utterance)
}

function toggleVoice() {
  voiceOn = !voiceOn
  localStorage.setItem("pet.voice.v3", voiceOn ? "1" : "0")
  if (!voiceOn) stopSpeech()
  refreshMenu()
}

function testVoice() {
  if (dancing) stopDance(false, false)
  const text = lastText || "你好，我是小尤桌宠，语音测试正常。"
  showBubble(text)
  speak(text, true)
}

async function speakNext() {
  if (dancing) stopDance(false, false)
  stopSpeech()
  showBubble("让我想想下一条…")
  await autonomousTalk(true)
}

function openComposer() {
  settings.classList.add("hidden")
  menu.classList.add("hidden")
  bubble.classList.add("hidden")
  closeNewsDetail()
  hideChoices()
  stopSpeech()
  scheduleNextTalk()
  promptInput.placeholder = "对宠物说点什么…（Enter 发送）"
  composer.classList.remove("hidden")
  promptInput.focus()
}

function openSongComposer() {
  openComposer()
  promptInput.placeholder = "想听什么歌？例如：播放 起风了"
}

let memory = { history: [], summary: "", updatedAt: 0, userTurns: 0 }
let history = []

function memoryNotes() {
  const parts = []
  if (memory.summary) parts.push(`长期记忆：\n${memory.summary}`)
  return parts.join("\n\n")
}

async function loadMemory() {
  try {
    const data = await invoke("load_memory")
    if (data && typeof data === "object") memory = { ...memory, ...data }
  } catch {}
  if (!Array.isArray(memory.history)) memory.history = []
  if (!memory.history.length) {
    try {
      const local = JSON.parse(localStorage.getItem("pet.history") || "[]")
      if (Array.isArray(local)) memory.history = local
    } catch {}
  }
  history = memory.history.slice(-100)
  if (history.length && !memory.updatedAt) saveHistory()
}

function saveHistory() {
  memory.history = history.slice(-100)
  memory.updatedAt = Date.now()
  localStorage.setItem("pet.history", JSON.stringify(history.slice(-20)))
  void invoke("save_memory", { data: memory })
}

let memoryUpdating = false

async function updateMemory() {
  if (memoryUpdating || history.length < 4) return
  memoryUpdating = true
  try {
    const transcript = history
      .slice(-24)
      .map((item) => `${item.role === "user" ? "用户" : "助手"}：${item.content}`)
      .join("\n")
    const prompt = `请把下面的旧记忆和对话合并成一段长期记忆。只保留用户姓名/称呼、偏好、习惯、重要事件、约定和需要记住的信息；用简洁中文，200字以内。\n\n旧记忆：\n${memory.summary || "无"}\n\n对话：\n${transcript}`
    const result = await invoke("chat", {
      text: prompt,
      history: [],
      model: currentModel(),
      memory: "",
      system: "你是记忆整理助手，只输出整理后的长期记忆，不要回答对话内容。",
    })
    if (result?.ok && result.text) {
      memory.summary = result.text.trim().slice(0, 600)
      history = history.slice(-40)
      saveHistory()
    }
  } catch {} finally {
    memoryUpdating = false
  }
}

function seedQuestionHistoryFromMemory() {
  const now = Date.now()
  const known = new Set(questionHistory.map((item) => item.text))
  const recent = history.slice(-40)
  let added = 0
  for (let index = 0; index < recent.length; index++) {
    const item = recent[index]
    if (item.role !== "assistant") continue
    const text = String(item.content || "").trim()
    if (!text.endsWith("？") || text.length > 80 || known.has(text)) continue
    const next = recent[index + 1]
    const answered = next?.role === "user"
    const at = now - (recent.length - index) * 5 * 60 * 1000
    questionHistory.push({
      text,
      at,
      answered,
      answeredAt: answered ? at + 60 * 1000 : 0,
      topic: questionTopic(text),
    })
    known.add(text)
    added += 1
  }
  if (added) {
    questionHistory = questionHistory.slice(-200)
    lastQuestionAt = questionHistory.reduce((max, item) => Math.max(max, item.at || 0), 0)
    saveQuestionHistory()
  }
}

await loadMemory()
seedQuestionHistoryFromMemory()

function currentModel() {
  const value = localStorage.getItem("pet.model") || ""
  const [providerID, id] = value.split("|")
  return providerID && id ? { providerID, id } : undefined
}

const talkKindWeights = [
  ["greeting", 3],
  ["comment", 5],
  ["weather", 1],
  ["ai-news", 1],
  ["world-news", 1],
  ["anime-news", 1],
  ["game-news", 1],
  ["acg-news", 1],
]

let lastTalkKind = ""
let lastNewsAt = 0

function pickTalkKind() {
  const pool = []
  for (const [kind, weight] of talkKindWeights) {
    for (let index = 0; index < weight; index++) pool.push(kind)
  }
  let kind = pool[Math.floor(Math.random() * pool.length)]
  if (kind === lastTalkKind && pool.length > 1) {
    kind = pool[Math.floor(Math.random() * pool.length)]
  }
  if (kind.endsWith("news") && Date.now() - lastNewsAt < 15 * 60 * 1000) {
    kind = "comment"
  }
  if (kind.endsWith("news")) lastNewsAt = Date.now()
  lastTalkKind = kind
  return kind
}

async function autonomousTalk(manual = false, forcedKind = "") {
  if (!manual && autoTalkBlocked()) return
  if (!forcedKind && Math.random() < 0.34 && (manual || questionAllowed())) {
    if (manual) scheduleNextTalk()
    const useDynamic = Math.random() < 0.6
    await askChoiceQuestion(useDynamic)
    return
  }
  const kind = forcedKind || pickTalkKind()
  talkBusy = true
  let prompt
  let pendingNews = null
  if (kind === "greeting") {
    prompt = "用一句自然、亲切的中文向用户打招呼，像桌面宠物一样，不要提问，不要超过20个字。"
  } else if (kind === "comment") {
    prompt =
      "像真人一样，结合当前时间和长期记忆，用一句自然、口语化的中文说一句日常观察、关心或轻松吐槽。绝对不要提问，不要使用问号，不要超过25个字。"
  } else {
    const topic = await invoke("topic", { kind }).catch(() => null)
    if (!topic?.ok) {
      const fallbacks = {
        weather: "用一句中文问候用户，并提醒注意天气。",
        "anime-news": "用一句中文和用户聊聊最近的新番动画。",
        "game-news": "用一句中文和用户聊聊最近在玩的游戏。",
        "acg-news": "用一句中文和用户聊聊最近的二次元话题。",
      }
      prompt = fallbacks[kind] || "用一句中文和用户聊聊最近的新鲜事。"
    } else if (kind === "weather") {
      prompt = `根据这条天气信息，用一两句自然的口语中文播报天气，并给一句简短提醒：${topic.text}`
    } else {
      const labels = {
        "ai-news": "AI 新闻",
        "world-news": "国际新闻",
        "anime-news": "二次元新闻",
        "game-news": "游戏新闻",
        "acg-news": "ACG 新闻",
      }
      prompt = `根据这些标题，用一两句自然的口语中文播报${labels[kind] || "新闻"}，不要逐条念：${topic.items.join("；")}`
      if (Array.isArray(topic.details) && topic.details.length) {
        pendingNews = { title: labels[kind] || "新闻详情", items: topic.details }
      }
    }
  }
  const result = await invoke("chat", {
    text: prompt,
    history: [],
    model: currentModel(),
    memory: memoryNotes(),
  }).catch(() => null)
  if (result?.ok && result.text) {
    lastText = cleanText(result.text)
    showBubble(lastText)
    if (pendingNews) showNewsButton(pendingNews.items, pendingNews.title)
    speak(lastText)
  } else if (manual) {
    lastText = "我现在还没想好说什么，稍后再聊吧。"
    showBubble(lastText)
    speak(lastText, true)
  }
  if (manual || forcedKind) scheduleNextTalk()
  talkBusy = false
}

function songQueryResult(query, strict) {
  const cleaned = query.trim().replace(/^[《"“「]|[》"”」]$/g, "").trim()
  if (!cleaned || /^(?:歌|歌曲|音乐|一首歌|首歌|点歌|吧|呀|啊)$/.test(cleaned)) {
    return { generic: true }
  }
  if (strict && /^(?:你|我|他|她|它|说|点|什么|啥|得|的|真|好|不|没|太|很)/.test(cleaned)) {
    return null
  }
  if (/^(?:器|列表|记录|失败|中|完|了|得|的|真|好|不|没|太|很)/.test(cleaned)) return null
  return { query: cleaned }
}

function parseSongRequest(text) {
  const cleaned = text.trim().replace(/[。！!？?]+$/g, "").trim()
  if (!cleaned) return null

  const quoted = cleaned.match(
    /(?:播放|放|唱|点|听)[^《"“「]{0,8}[《"“「]([^》"”」]+)[》"”」]/,
  )
  if (quoted) {
    const query = quoted[1].trim()
    return query ? { query } : null
  }

  const want = cleaned.match(
    /^(?:我)?(?:想|要)(听|点|唱)(?:一首|首|个|一下)?(?:歌曲|歌)?[：:\s]*(.*?)(?:吧|好吗|可以吗|呗)?$/,
  )
  if (want) {
    if (want[1] === "点" && !/[歌首《"“「]/.test(cleaned)) return null
    return songQueryResult(want[2], true)
  }

  const weakVerb = cleaned.match(/(?:^|[给帮为请能可以麻烦我，,\s])(放|来|点|听)(.)/)
  if (weakVerb && !/[一首个下点歌音《"“「\s：:]/.test(weakVerb[2])) return null

  const direct = cleaned.match(
    /^(?:(?:小尤|宝贝)[，,\s]*)?(?:(?:请|麻烦|能不能|可不可以|可以|能)[，,\s]*)?(?:(?:给我|帮我|为我)[，,\s]*)?(?:播放|放|来|唱|点|听)(?:一首|首|一个|一下|点)?(?:歌曲|歌)?[：:\s]*(.*?)(?:吧|好吗|可以吗|呗)?$/,
  )
  if (direct) return songQueryResult(direct[1], false)
  return null
}

function saveSongTurn(userText, assistantText) {
  history.push({ role: "user", content: userText })
  history.push({ role: "assistant", content: assistantText })
  history = history.slice(-100)
  memory.userTurns = (memory.userTurns || 0) + 1
  saveHistory()
  if (memory.userTurns % 4 === 0) void updateMemory()
}

async function playRequestedSong(request, userText) {
  if (request.generic) {
    lastText = "好呀，给你放首歌～"
    showBubble(lastText)
    saveSongTurn(userText, "好呀，给你放了一首歌。")
    await startSing()
    return
  }

  const query = request.query
  showBubble(`正在网上找《${query}》…`)
  talkBusy = true
  let result = null
  try {
    result = await invoke("fetch_song", { query }).catch(() => null)
  } finally {
    talkBusy = false
  }

  if (result?.ok && result.track) {
    const track = result.track
    lastText = `找到啦，为你播放《${track.name}》。`
    showBubble(lastText)
    saveSongTurn(userText, lastText)
    await startSing(track)
    return
  }

  console.error("[song] fetch failed", result?.error)
  const localTracks = (await invoke("list_music").catch(() => [])) || []
  const needle = query.toLowerCase()
  const local = localTracks.find((item) => item.name.toLowerCase().includes(needle))
  if (local) {
    lastText = `网上没找到，先放本地的《${local.name}》～`
    showBubble(lastText)
    saveSongTurn(userText, lastText)
    await startSing(local)
    return
  }

  lastText = `没找到能播放的《${query}》，换个歌名或加上歌手试试？`
  showBubble(lastText)
  speak(lastText)
  saveSongTurn(userText, lastText)
}

async function sendPrompt(rawText, contextQuestion = null, displayText = null) {
  if (dancing) stopDance(false, false)
  stopSpeech()
  const text = (rawText ?? promptInput.value).trim()
  if (!text) return
  if (rawText == null) promptInput.value = ""
  composer.classList.add("hidden")
  const openQuestion = pendingChoice?.question || null
  const songRequest = parseSongRequest(text)
  if (songRequest) {
    await playRequestedSong(songRequest, text)
    return
  }
  if (openQuestion) markQuestionAnswered(openQuestion)
  const answeredQuestion = contextQuestion || openQuestion
  showBubble(`你：${displayText || text}`)
  const outgoingHistory = contextQuestion
    ? [...history, { role: "assistant", content: contextQuestion }]
    : history
  talkBusy = true
  let result
  try {
    result = await invoke("chat", {
      text,
      history: outgoingHistory,
      model: currentModel(),
      memory: memoryNotes(),
    }).catch(() => null)
  } finally {
    talkBusy = false
  }
  if (!result?.ok || !result.text) {
    showBubble(`回复失败：${result?.error || result?.status || "未知错误"}`)
    scheduleNextTalk(answeredQuestion ? 150000 + Math.random() * 120000 : undefined)
    return
  }
  if (contextQuestion) history.push({ role: "assistant", content: contextQuestion })
  history.push({ role: "user", content: text })
  history.push({ role: "assistant", content: result.text })
  history = history.slice(-100)
  memory.userTurns = (memory.userTurns || 0) + 1
  saveHistory()
  if (memory.userTurns % 4 === 0) void updateMemory()
  lastText = cleanText(result.text)
  showBubble(lastText)
  speak(lastText)
  scheduleNextTalk(answeredQuestion ? 150000 + Math.random() * 120000 : undefined)
}

let models = []

async function ensureDefaultModel() {
  if (localStorage.getItem("pet.model")) return
  const list = (await invoke("list_models")) || []
  if (!list.length) return
  const go = list.filter((item) => item.providerID === "opencode-go")
  const pick = go.find((item) => /flash/i.test(item.id)) || go[0] || list[0]
  if (pick) localStorage.setItem("pet.model", `${pick.providerID}|${pick.id}`)
}

const modeOptions = [
  { value: "go", label: "OpenCode Go" },
  { value: "api", label: "API" },
]

const piperAvailable = await invoke("has_piper_voice").catch(() => false)

const voiceOptions = [
  { value: "zh-CN-XiaoxiaoNeural", label: "晓晓 · 温暖（女）" },
  { value: "zh-CN-XiaoyiNeural", label: "晓伊 · 二次元（女）" },
  ...(piperAvailable ? [{ value: "piper-huayan", label: "华颜 · 温柔甜美（离线）" }] : []),
  { value: "ja-JP-NanamiNeural", label: "七海 · 日语（女）" },
  { value: "en-US-AvaMultilingualNeural", label: "Ava · 多语言（女）" },
  { value: "en-US-EmmaMultilingualNeural", label: "Emma · 多语言（女）" },
  { value: "fr-FR-VivienneMultilingualNeural", label: "Vivienne · 多语言（女）" },
  { value: "de-DE-SeraphinaMultilingualNeural", label: "Seraphina · 多语言（女）" },
  { value: "ko-KR-SunHiNeural", label: "SunHi · 韩语（女）" },
  { value: "pt-BR-ThalitaMultilingualNeural", label: "Thalita · 多语言（女）" },
  { value: "zh-CN-YunjianNeural", label: "云健 · 激情（男）" },
  { value: "zh-CN-YunxiNeural", label: "云希 · 阳光（男）" },
  { value: "zh-CN-YunxiaNeural", label: "云夏 · 可爱（男）" },
  { value: "zh-CN-YunyangNeural", label: "云扬 · 专业（男）" },
  { value: "zh-CN-liaoning-XiaobeiNeural", label: "晓北 · 东北话（女）" },
  { value: "zh-CN-shaanxi-XiaoniNeural", label: "晓妮 · 陕西话（女）" },
  { value: "zh-HK-HiuGaaiNeural", label: "曉佳 · 粤语（女）" },
  { value: "zh-HK-HiuMaanNeural", label: "曉曼 · 粤语（女）" },
  { value: "zh-HK-WanLungNeural", label: "雲龍 · 粤语（男）" },
  { value: "zh-TW-HsiaoChenNeural", label: "曉臻 · 台湾（女）" },
  { value: "zh-TW-HsiaoYuNeural", label: "曉雨 · 台湾（女）" },
  { value: "zh-TW-YunJheNeural", label: "雲哲 · 台湾（男）" },
  { value: "system", label: "系统语音（离线）" },
]

const rateOptions = [
  { value: "-20%", label: "慢" },
  { value: "-10%", label: "稍慢" },
  { value: "+0%", label: "正常" },
  { value: "+10%", label: "稍快" },
  { value: "+20%", label: "快" },
]

const pitchOptions = [
  { value: "-5Hz", label: "低" },
  { value: "+0Hz", label: "正常" },
  { value: "+5Hz", label: "高" },
  { value: "+10Hz", label: "很高（偏二次元）" },
]

const scaleOptions = [
  { value: "0.8", label: "80%" },
  { value: "1", label: "100%" },
  { value: "1.5", label: "150%" },
  { value: "2.1", label: "210%" },
  { value: "2.7", label: "270%" },
  { value: "3.5", label: "350%" },
  { value: "4.9", label: "490%" },
]

function closeAllDropdowns(except) {
  document.querySelectorAll(".dd-list").forEach((element) => {
    if (element !== except) element.classList.add("hidden")
  })
}

function createDropdown(root, options, value, onChange) {
  let current = value
  let items = options

  const trigger = document.createElement("button")
  trigger.type = "button"
  trigger.className = "dd-trigger"
  const list = document.createElement("div")
  list.className = "dd-list hidden"

  const render = () => {
    list.innerHTML = ""
    for (const option of items) {
      const button = document.createElement("button")
      button.type = "button"
      button.className = `dd-option${option.value === current ? " active" : ""}`
      button.textContent = option.label
      button.addEventListener("click", (event) => {
        event.stopPropagation()
        current = option.value
        list.classList.add("hidden")
        render()
        onChange?.(current)
      })
      list.appendChild(button)
    }
    const selected = items.find((item) => item.value === current)
    trigger.textContent = selected?.label ?? items[0]?.label ?? ""
  }

  trigger.addEventListener("click", (event) => {
    event.stopPropagation()
    closeAllDropdowns(list)
    const rect = trigger.getBoundingClientRect()
    const below = window.innerHeight - rect.bottom - 8
    const above = rect.top - 8 - 28
    const openUp = below < Math.min(220, above)
    list.classList.toggle("up", openUp)
    list.style.maxHeight = `${Math.max(80, Math.min(220, openUp ? above : below))}px`
    list.classList.toggle("hidden")
    list.scrollTop = 0
  })

  root.append(trigger, list)
  render()

  return {
    get value() {
      return current
    },
    setOptions(next) {
      items = next
      if (!next.some((item) => item.value === current)) current = next[0]?.value
      render()
    },
    setValue(next) {
      current = next
      render()
    },
  }
}

const modeDropdown = createDropdown(
  ddMode,
  modeOptions,
  localStorage.getItem("pet.mode") || "go",
  (value) => {
    localStorage.setItem("pet.mode", value)
    fillModels()
  },
)

const modelDropdown = createDropdown(ddModel, [], "", (value) => {
  localStorage.setItem("pet.model", value)
  settingsHint.textContent = "已选择模型"
})

let modelFiles = []

function renderModelMenu() {
  if (!menuModelList) return
  menuModelList.innerHTML = ""
  const current = localStorage.getItem("pet.modelUrl") || "./sample.vrm"
  const items = [{ name: "默认示例", url: "./sample.vrm" }, ...modelFiles]
  for (const item of items) {
    const button = document.createElement("button")
    button.type = "button"
    button.textContent = (item.url === current ? "✓ " : "") + item.name
    if (item.url === current) button.classList.add("active")
    button.addEventListener("click", (event) => {
      event.stopPropagation()
      closeMenu()
      void switchModel(item.url, item.name)
    })
    menuModelList.append(button)
  }
}

async function switchModel(url, name) {
  if (dancing) stopDance(false, false)
  localStorage.setItem("pet.modelUrl", url)
  showBubble(`正在切换到 ${name}…`)
  try {
    await loadModel(url)
    showBubble(`已切换到 ${name}`)
  } catch {
    showBubble("模型加载失败")
  }
}

async function loadModelFiles() {
  const list = (await invoke("list_model_files")) || []
  modelFiles = list.map((item) => ({ name: item.name, url: convertFileSrc(item.path) }))
  renderModelMenu()
}

let animationFiles = []
let lastRandomAction = ""

function renderAnimMenu() {
  if (!menuAnimList) return
  menuAnimList.innerHTML = ""
  const items = [...animationFiles]
  for (const item of items) {
    const button = document.createElement("button")
    button.type = "button"
    button.textContent = item.name
    button.addEventListener("click", (event) => {
      event.stopPropagation()
      closeMenu()
      if (dancing) stopDance(false, false)
      void playAnimation(item.url)
      showBubble(`动作：${item.name}`)
    })
    menuAnimList.append(button)
  }
}

let danceAudio = null
let dancing = false
let singing = false

function playDefaultIdle() {
  if (defaultIdleUrl) void playAnimation(defaultIdleUrl)
}

function stopDance(showText = true, restoreIdle = true) {
  animationToken += 1
  const was = dancing
  const wasSinging = singing
  dancing = false
  singing = false
  if (danceAudio) {
    danceAudio.onended = null
    danceAudio.onerror = null
    danceAudio.pause()
    danceAudio.currentTime = 0
    danceAudio = null
  }
  if (was && mixer) {
    mixer.stopAllAction()
    mixer = null
  }
  if (restoreIdle) playDefaultIdle()
  if (showText && was) showBubble(wasSinging ? "已停止唱歌" : "已停止跳舞")
  if (was) scheduleNextTalk()
}

async function startDance() {
  stopDance(false, false)
  const tracks = (await invoke("list_music")) || []
  if (!tracks.length) {
    showBubble("mp3 文件夹里没有音乐")
    return
  }
  const dances = animationFiles.filter((item) => /^dance/i.test(item.name))
  if (!dances.length) {
    showBubble("animations 里没有舞蹈动作")
    return
  }
  const track = tracks[Math.floor(Math.random() * tracks.length)]
  const dance = dances[Math.floor(Math.random() * dances.length)]
  const audio = new Audio(convertFileSrc(track.path))
  audio.volume = 0.55
  audio.onended = () => {
    if (danceAudio === audio) {
      stopDance(false)
      showBubble("音乐结束，停止跳舞")
    }
  }
  audio.onerror = () => {
    if (danceAudio === audio) {
      stopDance(false)
      showBubble("音乐播放失败")
    }
  }
  danceAudio = audio
  dancing = true
  try {
    await audio.play()
    const token = await playAnimation(dance.url)
    if (token == null) {
      if (danceAudio === audio) {
        stopDance(false)
        showBubble("舞蹈动作加载失败")
      }
      return
    }
    if (danceAudio !== audio || !dancing) {
      if (danceAudio === audio) stopDance(false)
      return
    }
    showBubble(`跳舞中：${dance.name} ♪ ${track.name}`)
  } catch {
    stopDance(false)
    showBubble("音乐播放失败")
  }
}

async function startSing(trackOverride = null) {
  stopDance(false, false)
  const tracks = trackOverride ? [trackOverride] : (await invoke("list_music")) || []
  if (!tracks.length) {
    showBubble("mp3 文件夹里没有音乐")
    return
  }
  const pool = animationFiles.filter(
    (item) => item.url && !/^dance/i.test(item.name) && !/^(grabbed|[a-e])$/i.test(item.name),
  )
  const action = pool[Math.floor(Math.random() * pool.length)]
  if (!action) {
    showBubble("animations 里没有可用动作")
    return
  }
  const track = tracks[Math.floor(Math.random() * tracks.length)]
  const audio = new Audio(convertFileSrc(track.path))
  audio.volume = 0.55
  audio.onended = () => {
    if (danceAudio === audio) {
      stopDance(false)
      showBubble("音乐结束，停止唱歌")
    }
  }
  audio.onerror = () => {
    if (danceAudio === audio) {
      stopDance(false)
      showBubble("音乐播放失败")
    }
  }
  danceAudio = audio
  dancing = true
  singing = true
  try {
    await audio.play()
    const token = await playAnimation(action.url)
    if (token == null) {
      if (danceAudio === audio) {
        stopDance(false)
        showBubble("唱歌动作加载失败")
      }
      return
    }
    if (danceAudio !== audio || !dancing) {
      if (danceAudio === audio) stopDance(false)
      return
    }
    showBubble(`唱歌中：${track.name} ♪`)
  } catch {
    stopDance(false)
    showBubble("音乐播放失败")
  }
}

function randomAction() {
  if (dancing) stopDance(false, false)
  const pool = animationFiles.filter((item) => item.url && !/^(grabbed|[a-e])$/i.test(item.name))
  if (!pool.length) return
  const choices = pool.length > 1 ? pool.filter((item) => item.name !== lastRandomAction) : pool
  const pick = choices[Math.floor(Math.random() * choices.length)]
  lastRandomAction = pick.name
  void playAnimation(pick.url)
  showBubble(`动作：${pick.name}`)
}

async function loadAnimationList() {
  const list = (await invoke("list_animations")) || []
  const rank = (name) => {
    if (name === "idle-maid") return 0
    if (name === "idle-sitting") return 1
    if (name === "FancyDressParty") return 2
    if (name === "Reading (Loop)") return 3
    if (/^dance/i.test(name)) return 4
    if (name === "grabbed") return 7
    if (/^[a-e]$/i.test(name)) return 8
    return 5
  }
  animationFiles = list
    .map((item) => ({ name: item.name, url: convertFileSrc(item.path) }))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
  const idle =
    animationFiles.find((item) => item.name === "idle-maid") ||
    animationFiles.find((item) => item.name === "neutral_idle") ||
    animationFiles[0]
  defaultIdleUrl = idle?.url || ""
  animationUrls = list
    .filter((item) => !/^(grabbed|[a-e])$/i.test(item.name))
    .map((item) => convertFileSrc(item.path))
  renderAnimMenu()
  if (!mixer && !dancing) playDefaultIdle()
}

if (localStorage.getItem("pet.voiceName") === "zh-CN-XiaoxiaoNeural" && !localStorage.getItem("pet.voice.anime")) {
  localStorage.setItem("pet.voiceName", "zh-CN-XiaoyiNeural")
  localStorage.setItem("pet.voice.anime", "1")
}
const voiceDropdown = createDropdown(
  ddVoice,
  voiceOptions,
  localStorage.getItem("pet.voiceName") || "zh-CN-XiaoyiNeural",
  (value) => {
    localStorage.setItem("pet.voiceName", value)
    voiceOn = true
    localStorage.setItem("pet.voice.v3", "1")
    if (value === "piper-huayan") {
      localStorage.setItem("pet.pitch", "+0Hz")
      pitchDropdown?.setValue("+0Hz")
      settingsHint.textContent = "华颜是离线音色：音调无效，语速有效"
    } else {
      settingsHint.textContent = ""
    }
    refreshMenu()
  },
)

const rateDropdown = createDropdown(
  ddRate,
  rateOptions,
  localStorage.getItem("pet.rate") || "+0%",
  (value) => localStorage.setItem("pet.rate", value),
)

const pitchDropdown = createDropdown(
  ddPitch,
  pitchOptions,
  localStorage.getItem("pet.pitch") || "+0Hz",
  (value) => localStorage.setItem("pet.pitch", value),
)

const scaleDropdown = createDropdown(ddScale, scaleOptions, String(viewScale), (value) => {
  localStorage.setItem("pet.scale", value)
  void applyWindowScale(value)
})

if (voiceDropdown.value === "piper-huayan") {
  if (localStorage.getItem("pet.pitch") !== "+0Hz") {
    localStorage.setItem("pet.pitch", "+0Hz")
    pitchDropdown.setValue("+0Hz")
  }
  settingsHint.textContent = "华颜是离线音色：音调无效，语速有效"
}

talkDropdown = createDropdown(ddTalk, talkModeOptions, talkMode, (value) => setTalkMode(value))

function fillModels() {
  const mode = modeDropdown.value
  const list = models.filter((item) =>
    mode === "go" ? item.providerID === "opencode-go" : item.providerID !== "opencode-go",
  )
  const options = list.map((item) => ({
    value: `${item.providerID}|${item.id}`,
    label: `${item.name} (${item.providerID})`,
  }))
  modelDropdown.setOptions(options)
  const saved = localStorage.getItem("pet.model") || ""
  if (saved && options.some((option) => option.value === saved)) {
    modelDropdown.setValue(saved)
  }
  settingsHint.textContent = options.length ? "" : "该来源没有可用模型"
}

async function openSettings() {
  composer.classList.add("hidden")
  menu.classList.add("hidden")
  bubble.classList.add("hidden")
  closeNewsDetail()
  hideChoices()
  settings.classList.toggle("hidden")
  if (settings.classList.contains("hidden")) return
  scheduleNextTalk()
  settings.scrollTop = 0
  if (!models.length) models = (await invoke("list_models")) || []
  fillModels()
  if (voiceDropdown.value === "piper-huayan") {
    settingsHint.textContent = "华颜是离线音色：音调无效，语速有效"
  }
  void loadAnimationList()
}

function refreshClickThrough() {
  if (!settingsClickThrough) return
  const enabled = localStorage.getItem("pet.clickThrough") === "1"
  settingsClickThrough.textContent = enabled ? "开启" : "关闭"
  settingsClickThrough.classList.toggle("on", enabled)
}

function toggleClickThrough() {
  const next = localStorage.getItem("pet.clickThrough") !== "1"
  localStorage.setItem("pet.clickThrough", next ? "1" : "0")
  void invoke("set_click_through", { enabled: next })
  refreshMenu()
  refreshClickThrough()
  settingsHint.textContent = next
    ? "点击穿透已开启，按 Ctrl+Alt+P 关闭"
    : "点击穿透已关闭"
  showBubble(next ? "已开启点击穿透，Ctrl+Alt+P 或托盘菜单关闭" : "已关闭点击穿透")
}

function refreshMenu() {
  const muteItem = menu.querySelector('[data-action="mute"]')
  if (muteItem) muteItem.textContent = voiceOn ? "🔇 静音" : "🔊 开启朗读"
  refreshClickThrough()
  const talkItem = menu.querySelector('[data-action="talk"]')
  if (talkItem) talkItem.textContent = `💬 主动聊天：${talkMode === "off" ? "关闭" : talkModeLabel(talkMode).replace(/（.*）/, "")}`
}

function closeMenu() {
  menu.classList.add("hidden")
}

window.addEventListener("contextmenu", (event) => {
  if (event.target.closest("input, select, textarea, button, .settings, .composer, .context-menu, .news-detail, .news-more")) return
  closeNewsDetail()
  event.preventDefault()
  refreshMenu()
  renderModelMenu()
  renderAnimMenu()
  menuModelList?.classList.add("hidden")
  menuAnimList?.classList.add("hidden")
  menu.classList.remove("hidden")
  menuScroll.scrollTop = 0
  const width = menu.offsetWidth
  const height = menu.offsetHeight
  menu.style.left = `${Math.max(6, Math.min(event.clientX, window.innerWidth - width - 6))}px`
  menu.style.top = `${Math.max(30, Math.min(event.clientY, window.innerHeight - height - 6))}px`
})

window.addEventListener("dblclick", (event) => {
  if (performance.now() - lastChoiceClick < 600) return
  if (event.target.closest("input, select, textarea, button, .settings, .context-menu, .news-detail, .news-more")) return
  if (dancing) stopDance()
  else randomAction()
})

menu.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]")
  if (!button) return
  const action = button.dataset.action
  if (action === "switchModel" || action === "switchAnim") {
    if (action === "switchModel") {
      renderModelMenu()
      menuAnimList?.classList.add("hidden")
      menuModelList?.classList.toggle("hidden")
    } else {
      renderAnimMenu()
      menuModelList?.classList.add("hidden")
      menuAnimList?.classList.toggle("hidden")
    }
    if (!menuModelList?.classList.contains("hidden") || !menuAnimList?.classList.contains("hidden")) {
      menuScroll.scrollTop = Math.max(0, button.offsetTop - 30)
    }
    const rect = menu.getBoundingClientRect()
    const overflow = rect.bottom - window.innerHeight + 6
    if (overflow > 0) menu.style.top = `${Math.max(30, rect.top - overflow)}px`
    return
  }
  closeMenu()
  if (action === "compose") openComposer()
  else if (action === "song") openSongComposer()
  else if (action === "voice") testVoice()
  else if (action === "voiceNext") void speakNext()
  else if (action === "mute") toggleVoice()
  else if (action === "settings") void openSettings()
  else if (action === "clickThrough") toggleClickThrough()
  else if (action === "talk") cycleTalkMode()
  else if (action === "dance") void startDance()
  else if (action === "sing") void startSing()
  else if (action === "quit") appWindow.close()
})

async function importAnimation() {
  const picked = await invoke("pick_animation")
  if (!picked) return
  if (dancing) stopDance(false)
  await playAnimation(convertFileSrc(picked.path))
  await loadAnimationList()
  showBubble(`已导入动作：${picked.name}`)
}

sendButton.addEventListener("click", () => void sendPrompt())
document.getElementById("composer-close").addEventListener("click", () => composer.classList.add("hidden"))
document.getElementById("settings-close").addEventListener("click", () => settings.classList.add("hidden"))
document.getElementById("settings-models").addEventListener("click", () => void invoke("open_models"))
document.getElementById("settings-importAnim").addEventListener("click", () => void importAnimation())
settingsClickThrough.addEventListener("click", (event) => {
  event.stopPropagation()
  toggleClickThrough()
})
document.getElementById("news-close").addEventListener("click", closeNewsDetail)

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    settings.classList.add("hidden")
    closeMenu()
    closeNewsDetail()
  }
})

promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault()
    void sendPrompt()
  } else if (event.key === "Escape") {
    composer.classList.add("hidden")
  }
})

let dragOrigin = null

let lastInteractive = null

function publishZones() {
  if (
    !composer.classList.contains("hidden") ||
    !settings.classList.contains("hidden") ||
    !menu.classList.contains("hidden") ||
    !newsDetail.classList.contains("hidden") ||
    document.querySelector(".dd-list:not(.hidden)")
  ) {
    void invoke("set_zones", { zones: [{ x: 0, y: 28, w: window.innerWidth, h: window.innerHeight - 28 }] })
    return
  }

  const zones = []
  const canvasRect = canvas.getBoundingClientRect()
  zones.push({
    x: canvasRect.left + 20,
    y: canvasRect.top + 28,
    w: canvasRect.width - 40,
    h: canvasRect.height - 28,
  })

  if (!bubble.classList.contains("hidden")) {
    const rect = bubble.getBoundingClientRect()
    zones.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height })
  }

  if (!choices.classList.contains("hidden")) {
    const rect = choices.getBoundingClientRect()
    if (rect.width > 1 && rect.height > 1) {
      zones.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height })
    }
  }

  if (!newsMore.classList.contains("hidden")) {
    const rect = newsMore.getBoundingClientRect()
    zones.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height })
  }

  for (const element of [composer, menu, settings]) {
    if (!element.classList.contains("hidden")) {
      const rect = element.getBoundingClientRect()
      zones.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height })
    }
  }

  for (const element of document.querySelectorAll(".dd-list:not(.hidden)")) {
    const rect = element.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      zones.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height })
    }
  }

  void invoke("set_zones", { zones })
}

setInterval(publishZones, 120)
publishZones()

window.addEventListener("mousedown", (event) => {
  if (!event.target.closest(".dd")) closeAllDropdowns()
  if (!menu.classList.contains("hidden") && !menu.contains(event.target)) closeMenu()
  if (!newsDetail.classList.contains("hidden") && !newsDetail.contains(event.target)) closeNewsDetail()
  if (
    !settings.classList.contains("hidden") &&
    !settings.contains(event.target) &&
    !menu.contains(event.target)
  ) {
    settings.classList.add("hidden")
  }
  if (event.button !== 0) return
  if (event.target.closest("input, select, textarea, button, .settings, .composer, .context-menu, .news-detail, .news-more")) return
  dragOrigin = { x: event.clientX, y: event.clientY }
  event.preventDefault()
})

window.addEventListener("mousemove", (event) => {
  if (!dragOrigin) return
  if (Math.hypot(event.clientX - dragOrigin.x, event.clientY - dragOrigin.y) < 4) return
  dragOrigin = null
  void appWindow.startDragging()
})

window.addEventListener("mouseup", () => {
  dragOrigin = null
})

window.addEventListener("mousedown", () => {
  if ("speechSynthesis" in window) speechSynthesis.resume()
})

const clock = new THREE.Clock()

function animate() {
  const delta = clock.getDelta()
  const time = clock.elapsedTime

  if (performance.now() > nextTalk && !autoTalkBlocked()) {
    scheduleNextTalk()
    void autonomousTalk()
  }
  if (!mixer && !speaking && !dancing && animationUrls.length && performance.now() > nextAnim) {
    nextAnim = performance.now() + 45000 + Math.random() * 60000
    const url = animationUrls[Math.floor(Math.random() * animationUrls.length)]
    void playAnimation(url)
      .then((token) => {
        if (token == null) return
        setTimeout(() => {
          if (token === animationToken && !dancing && mixer) {
            mixer.stopAllAction()
            mixer = null
          }
        }, 8000)
      })
      .catch(() => {})
  }
  if (hiddenAt && performance.now() > hiddenAt) {
    bubble.classList.add("hidden")
    newsMore.classList.add("hidden")
    hideChoices()
    hiddenAt = 0
  }

  if (vrm) {
    vrm.scene.position.y = 0

    vrm.scene.rotation.y = baseYaw

    if (mixer) {
      mixer.update(delta)
    } else {
    addBoneRotation("leftUpperLeg", 0, 0, 0)
    addBoneRotation("rightUpperLeg", 0, 0, 0)
    addBoneRotation("head", Math.sin(time * 1.2) * 0.015, 0, 0)
    addBoneRotation("rightUpperArm", 0, 0, 1.1 + Math.sin(time * 1.6) * 0.03)
    addBoneRotation("leftUpperArm", 0, 0, -1.1 - Math.sin(time * 1.6) * 0.03)
    addBoneRotation("rightLowerArm", 0, 0, 0)
    addBoneRotation("leftLowerArm", 0, 0, 0)
    }

    if (time > nextBlink) {
      blinkUntil = time + 0.12
      nextBlink = time + 2.5 + Math.random() * 4
    }
    vrm.expressionManager?.setValue("blink", time < blinkUntil ? 1 : 0)

    if (speaking || singing) {
      mouthTimer -= delta
      if (mouthTimer <= 0) {
        mouthIndex = (mouthIndex + 1 + Math.floor(Math.random() * 2)) % visemes.length
        mouthTimer = 0.07 + Math.random() * 0.07
      }
      visemes.forEach((name, index) => {
        vrm.expressionManager?.setValue(name, index === mouthIndex ? 0.55 : 0)
      })
    } else {
      visemes.forEach((name) => vrm.expressionManager?.setValue(name, 0))
    }

    vrm.update(delta)
    updateAutoFrame(time)
    camera.lookAt(frameLookX, frameLookY, 0)
  }

  renderer.render(scene, camera)
  requestAnimationFrame(animate)
}

animate()
void loadAnimationList()
void loadModelFiles()
void ensureDefaultModel()
void applyWindowScale(viewScale)
refreshClickThrough()
if (localStorage.getItem("pet.clickThrough") === "1") {
  void invoke("set_click_through", { enabled: true })
}
void listen("click-through-changed", (event) => {
  localStorage.setItem("pet.clickThrough", event.payload ? "1" : "0")
  refreshMenu()
  refreshClickThrough()
})
