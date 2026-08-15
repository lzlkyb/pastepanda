//! 厂商预设与 AI 配置。
//!
//! 所有厂商走同一套 **OpenAI 兼容** 的 `/chat/completions`，所以“换厂商”实际上
//! 只是换 base_url + model + Key。因此这里是**一张表而不是一个枚举**：
//! 加厂商只需追一行，不用改任何 match 分支。
//!
//! **地址来源**：2026-08-08 逐家用假 Key 实测过——返回 401 证明路径正确且为
//! OpenAI 兼容端点（404 才是路径错）。Ollama 除外，它要求本机已安装，未验证。
//!
//! **单价表会过时**。它只用来拦住失控的连续调用，不是对账；真实金额以账单为准。
//! 取值一律偏高：高估只会让预算提前拦截，低估会让预算失效。
//!
//! **模型清单会过期得更快**。2026-08-08 按各家官方文档刷新过一轮：
//! DeepSeek / 通义千问 / 智谱 / Kimi / MiniMax / OpenAI / Anthropic 是抄文档原文的；
//! 混元 / 千帆 / 星火 / 阶跃 / 零一万物 **未能核实**，可能已经过时。
//! 正因为如此，界面上每一家都带可手填的模型输入框——清单只是快捷方式，
//! 不能成为围栏。

use serde::{Deserialize, Serialize};

/// 接口协议。目前事实标准就这两种。
///
/// **为什么协议不绑死在厂商上**：同一家常常两种都提供。实测（2026-08-08）
/// 智谱除了 `…/api/paas/v4`（OpenAI 格式）还有 `…/api/anthropic/v1/messages`（401，
/// 路径正确）。大量中转服务也同时暴露两套。所以协议可在高级区单独覆盖。
// 序列化值必须与 `id()` 一致（openai / anthropic）：前端的协议下拉直接用这个字符串，
// 若这里出来的是 open_ai 就对不上了。有测试盯着。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    /// `POST {base}/chat/completions`，`Authorization: Bearer <key>`
    OpenAi,
    /// `POST {base}/messages`，`x-api-key: <key>` + `anthropic-version` 头
    Anthropic,
}

impl Protocol {
    pub fn from_id(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "openai" | "open_ai" => Some(Protocol::OpenAi),
            "anthropic" => Some(Protocol::Anthropic),
            _ => None,
        }
    }

    pub fn id(&self) -> &'static str {
        match self {
            Protocol::OpenAi => "openai",
            Protocol::Anthropic => "anthropic",
        }
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            Protocol::OpenAi => "OpenAI 兼容（/chat/completions）",
            Protocol::Anthropic => "Anthropic Messages（/messages）",
        }
    }
}

/// 默认厂商。选 DeepSeek 而非 OpenAI 不是偏好是网络实况：
/// 国内直连 `api.openai.com` 多半不通，默认值必须是拿起来就能用的那个。
pub const DEFAULT_PROVIDER: &str = "deepseek";

/// 美元→人民币的近似汇率。会漂移，同样只用于展示与预算拦截。
pub const USD_TO_CNY: f64 = 7.2;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpec {
    pub id: &'static str,
    /// 给人看的说明，如“便宜快速（推荐）”
    pub label: &'static str,
    /// 推理模型：回答前先输出一大段思维链，而思考的 token **照样计费也照样占用**
    /// `max_tokens` 额度。给小了会变成“额度全花在思考上、答案一个字都没生成”。
    ///
    /// 这个标记**只是界面提示**，不是安全网：它必然不全（用户可以手填任意模型名，
    /// 厂商也会随时上新模型）。真正兑现的保护在 `client.rs`：剥离 `<think>`
    /// 与截断检测对所有模型都生效，不依赖这张表准不准。
    pub reasoning: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSpec {
    pub id: &'static str,
    pub name: &'static str,
    /// 不带尾斜杠。空串表示必须用户自填（custom）。
    pub base_url: &'static str,
    pub models: &'static [ModelSpec],
    /// 申请 API Key 的页面。国内用户最大的卡点就是“不知道去哪申请”。
    pub key_url: &'static str,
    /// 一句话说明，显示在下拉框下方。
    pub note: &'static str,
    /// false 表示不需要 API Key（目前只有 Ollama）。
    pub needs_key: bool,
    /// true 表示模型要用户自由输入而不是下拉选。
    ///
    /// 火山方舟填的是**推理接入点 ID**（`ep-...`）而不是模型名，
    /// 给个模型下拉只会让用户必然填错。
    pub model_is_free_text: bool,
    /// 模型输入框的占位提示（仅 model_is_free_text 时用）。
    pub model_hint: &'static str,
    /// 每百万 token 粗略单价（美元）：输入 / 输出。
    pub price_in: f64,
    pub price_out: f64,
    /// 该厂商默认的接口协议；用户可在高级区覆盖。
    pub protocol: Protocol,
}

/// 关掉“思考”要往请求里加什么字段。各家写法不统一，所以得分类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThinkingControl {
    /// 没有**已核实**的开关。不发任何额外字段——瞎猜字段名的后果是 400，
    /// 比“没关成”严重得多。
    Unsupported,
    /// `"thinking": {"type": "disabled"}`
    TypeObject,
    /// `"enable_thinking": false`
    EnableFlag,
}

impl ProviderSpec {
    /// 默认模型 = 清单里的第一项。
    pub fn default_model(&self) -> &'static str {
        self.models.first().map(|m| m.id).unwrap_or("")
    }

    /// 该厂商支持哪种“关掉思考”写法。
    ///
    /// **只列查到官方文档的四家**（2026-08-08 核实），而且四家都是**默认开思考**：
    /// - DeepSeek v4：`thinking.type`，默认 enabled（effort=high）——它是我们的**默认厂商**
    /// - 智谱 GLM-4.7：同形状
    /// - MiniMax：同形状，但开的那个值叫 `adaptive` 而非 `enabled`
    /// - 通义千问 3.5+：`enable_thinking`，默认 true
    ///
    /// 其他家一律 `Unsupported`。宁可不发也不瞎发：发个对方不认识的字段，
    /// 乐观情况是被忽略，悲观情况是整个请求 400。
    ///
    /// 注意：我们只用 `disabled`，不用开启值，所以 MiniMax 那个
    /// `adaptive`/`enabled` 的差异碰不到——四家关闭写法是一致的。
    pub fn thinking_control(&self) -> ThinkingControl {
        match self.id {
            "deepseek" | "zhipu" | "minimax" => ThinkingControl::TypeObject,
            "qwen" => ThinkingControl::EnableFlag,
            _ => ThinkingControl::Unsupported,
        }
    }

    /// 是否本地运行（内容不出机器、零费用）。
    ///
    /// **显式白名单（ollama）**：不要按「needs_key=false 且 price=0」推断——
    /// builtin-agnes 也是免 key + 免费，但它是**远程**的（内容出网、有配额）。
    /// 按旧推断它会被当成 local，出网敏感闸和配额检查全部跳过，等于裸奔。
    pub fn is_local(&self) -> bool {
        self.id == "ollama"
    }

    /// 是否内置免费额度服务商（token 配额计费，替代金额预算）。
    pub fn is_builtin_free(&self) -> bool {
        self.id == BUILTIN_AGNES_ID
    }
}

/// 内置免费额度服务商 id（签到送 token 玩法的载体，与自配服务商完全隔离）。
pub const BUILTIN_AGNES_ID: &str = "builtin-agnes";
/// 内置公共免费 API key（应用作者在 Agnes 后台申请）。
///
/// 不存明文：编译期 XOR 混淆 + 运行时还原（见 `crate::mask`），防止
/// `strings` 级别的明文扫描直接搜到 `sk-` 前缀。免费场景 key 仍内置在
/// 客户端、可被逆向提取，属可接受取舍。
pub fn builtin_agnes_key() -> String {
    const XOR: u8 = 0x5A;
    const BUF: &[u8] = &[
        0x29, 0x31, 0x77, 0x20, 0x1c, 0x6d, 0x2e, 0x31, 0x09, 0x36, 0x63, 0x17, 0x30, 0x69,
        0x63, 0x6c, 0x2d, 0x6e, 0x6e, 0x6b, 0x6d, 0x18, 0x02, 0x09, 0x11, 0x1d, 0x38, 0x2c,
        0x0a, 0x3b, 0x34, 0x1c, 0x0e, 0x36, 0x0f, 0x2b, 0x69, 0x0d, 0x15, 0x2d, 0x38, 0x39,
        0x13, 0x17, 0x23, 0x6e, 0x14, 0x08, 0x3b, 0x6a, 0x19,
    ];
    crate::mask::reveal_xor(BUF, XOR)
}

/// 写法：`"模型名" => "说明"`；推理模型在后面多写一个 `reasoning`。
///
/// 字面量用 `literal` 而非 `expr`：`expr` 片段后面只允许跟 `=>` / `,` / `;`，
/// 接不上可选标记。
macro_rules! models {
    (@flag) => { false };
    (@flag reasoning) => { true };
    ($($id:literal => $label:literal $($flag:ident)?),* $(,)?) => {
        &[$(ModelSpec {
            id: $id,
            label: $label,
            reasoning: models!(@flag $($flag)?),
        }),*]
    };
}

/// 厂商清单。顺序即界面展示顺序：国内可直连的在前，本地/其他在后。
pub const PROVIDERS: &[ProviderSpec] = &[
    ProviderSpec {
        id: "deepseek",
        name: "DeepSeek",
        base_url: "https://api.deepseek.com/v1",
        models: models![
            "deepseek-v4-flash" => "便宜快速（推荐）",
            "deepseek-v4-pro" => "更强·更贵",
        ],
        key_url: "https://platform.deepseek.com/api_keys",
        note: "国内直连，便宜，中文好。新用户通常有免费额度。",
        needs_key: true,
        model_is_free_text: false,
        model_hint: "",
        // 按 v4-pro 取值（比 flash 高三倍），宁可早拦
        price_in: 0.44,
        price_out: 0.90,
        protocol: Protocol::OpenAi,
    },
    ProviderSpec {
        id: "qwen",
        name: "通义千问（阿里）",
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        models: models![
            "qwen3.7-flash" => "便宜快速（推荐）",
            "qwen3.7-plus" => "均衡",
            "qwen3.8-max" => "最强·最贵",
        ],
        key_url: "https://bailian.console.aliyun.com/?apiKey=1",
        note: "阿里百炼平台。需在控制台开通后获取 API-KEY。",
        needs_key: true,
        model_is_free_text: false,
        model_hint: "",
        price_in: 0.10,
        price_out: 0.30,
        protocol: Protocol::OpenAi,
    },
    ProviderSpec {
        id: "zhipu",
        name: "智谱 GLM",
        base_url: "https://open.bigmodel.cn/api/paas/v4",
        models: models![
            "glm-4.7-flash" => "免费（推荐）",
            "glm-4.7" => "均衡",
            "glm-5.2" => "最强·1M 上下文",
        ],
        key_url: "https://bigmodel.cn/usercenter/apikeys",
        note: "glm-4.7-flash 免费，适合先试。",
        needs_key: true,
        model_is_free_text: false,
        model_hint: "",
        // 默认档免费，但 glm-5.2 不是；单价未逐档核实，取偏高值
        price_in: 1.00,
        price_out: 3.00,
        protocol: Protocol::OpenAi,
    },
    ProviderSpec {
        id: "moonshot",
        name: "Kimi（月之暗面）",
        base_url: "https://api.moonshot.cn/v1",
        // 老的 moonshot-v1-* 系列官方公告 8 月 31 日下线，不能再预制
        models: models![
            "kimi-k2.6" => "通用（推荐）",
            "kimi-k2.5" => "更便宜",
            "kimi-k3" => "旗舰·很贵",
        ],
        key_url: "https://platform.kimi.com/console/api-keys",
        note: "长上下文见长。旧的 moonshot-v1-* 系列官方公告 8 月 31 日下线。",
        needs_key: true,
        model_is_free_text: false,
        model_hint: "",
        // 按 kimi-k3 取值（¥20/¥100 每百万，约 $2.8/$14）
        price_in: 2.80,
        price_out: 14.00,
        protocol: Protocol::OpenAi,
    },
    ProviderSpec {
        id: "volcengine",
        name: "豆包（火山方舟）",
        base_url: "https://ark.cn-beijing.volces.com/api/v3",
        models: &[],
        key_url: "https://console.volcengine.com/ark",
        note: "字节豆包。注意：这里填的是推理接入点 ID，不是模型名。",
        needs_key: true,
        model_is_free_text: true,
        model_hint: "ep-20260808xxxxxx-xxxxx（推理接入点 ID）",
        price_in: 0.15,
        price_out: 0.30,
        protocol: Protocol::OpenAi,
    },
    ProviderSpec {
        id: "hunyuan",
        name: "腾讯混元",
        base_url: "https://api.hunyuan.cloud.tencent.com/v1",
        models: models![
            "hunyuan-turbos-latest" => "快速（推荐）",
            "hunyuan-standard" => "标准",
        ],
        key_url: "https://console.cloud.tencent.com/hunyuan/api-key",
        note: "腾讯云控制台获取。",
        needs_key: true,
        model_is_free_text: false,
        model_hint: "",
        price_in: 0.15,
        price_out: 0.60,
        protocol: Protocol::OpenAi,
    },
    ProviderSpec {
        id: "qianfan",
        name: "百度千帆（文心）",
        base_url: "https://qianfan.baidubce.com/v2",
        models: models![
            "ernie-4.5-turbo-128k" => "快速（推荐）",
            "ernie-4.5-8k-preview" => "标准",
        ],
        key_url: "https://console.bce.baidu.com/iam/#/iam/apikey/list",
        note: "千帆 v2 接口，需使用百度智能云 API Key。",
        needs_key: true,
        model_is_free_text: false,
        model_hint: "",
        price_in: 0.15,
        price_out: 0.60,
        protocol: Protocol::OpenAi,
    },
    ProviderSpec {
        id: "spark",
        name: "讯飞星火",
        base_url: "https://spark-api-open.xf-yun.com/v1",
        models: models![
            "generalv3.5" => "通用（推荐）",
            "4.0Ultra" => "最强",
        ],
        key_url: "https://console.xfyun.cn/services/cbm",
        note: "星火开放平台。密钥形式为 APIPassword。",
        needs_key: true,
        model_is_free_text: false,
        model_hint: "",
        price_in: 0.30,
        price_out: 0.30,
        protocol: Protocol::OpenAi,
    },
    ProviderSpec {
        id: "stepfun",
        name: "阶跃星辰",
        base_url: "https://api.stepfun.com/v1",
        models: models![
            "step-1-8k" => "短文本（推荐）",
            "step-1-32k" => "中等上下文",
        ],
        key_url: "https://platform.stepfun.com/interface-key",
        note: "阶跃星辰开放平台。",
        needs_key: true,
        model_is_free_text: false,
        model_hint: "",
        price_in: 0.70,
        price_out: 0.70,
        protocol: Protocol::OpenAi,
    },
    ProviderSpec {
        id: "lingyiwanwu",
        name: "零一万物（Yi）",
        base_url: "https://api.lingyiwanwu.com/v1",
        models: models![
            "yi-lightning" => "快速便宜（推荐）",
            "yi-large" => "最强",
        ],
        key_url: "https://platform.lingyiwanwu.com/apikeys",
        note: "零一万物大模型开放平台。",
        needs_key: true,
        model_is_free_text: false,
        model_hint: "",
        price_in: 0.15,
        price_out: 0.15,
        protocol: Protocol::OpenAi,
    },
    ProviderSpec {
        id: "minimax",
        name: "MiniMax",
        // 国内站是 minimaxi.com（带 i），海外站才是 minimax.io；
        // 旧的 api.minimax.chat 已不是文档里的地址
        base_url: "https://api.minimaxi.com/v1",
        models: models![
            "MiniMax-M2.7-highspeed" => "快速（推荐）",
            "MiniMax-M2.7" => "标准",
            // 实测：M3 会把思维链内联在 `<think>…</think>` 里塞进正文，
            // 且官方文档写明 `thinking.type` 默认 `adaptive`。
            // 其余几档没实测过，宁可不标也不瞎标。
            "MiniMax-M3" => "最新旗舰" reasoning,
        ],
        key_url: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
        note: "MiniMax 开放平台。海外账号需把地址改成 api.minimax.io/v1。",
        needs_key: true,
        model_is_free_text: false,
        model_hint: "",
        // 单价未核实，取偏高值
        price_in: 1.00,
        price_out: 4.00,
        protocol: Protocol::OpenAi,
    },
    ProviderSpec {
        id: "siliconflow",
        name: "硅基流动（聚合）",
        base_url: "https://api.siliconflow.cn/v1",
        // 故意不预制：聚合平台上千个模型，上下架与免费名单变得很快，
        // 写死几个只会在它们下架后变成一键 404。让用户从模型广场拉名字更可靠。
        models: &[],
        key_url: "https://cloud.siliconflow.cn/account/ak",
        note: "聚合平台，一把 Key 用多家模型。型号从模型广场 cloud.siliconflow.cn/models 拷贝。",
        needs_key: true,
        model_is_free_text: true,
        model_hint: "从模型广场拷贝，形如 Qwen/Qwen3-8B",
        price_in: 0.20,
        price_out: 0.20,
        protocol: Protocol::OpenAi,
    },
    ProviderSpec {
        id: "ollama",
        name: "Ollama（本地）",
        base_url: "http://localhost:11434/v1",
        models: &[],
        key_url: "https://ollama.com/download",
        note: "完全本地运行：不需密钥、零费用、内容不出机器。需先自行安装并启动。",
        needs_key: false,
        model_is_free_text: true,
        model_hint: "qwen2.5（填你 ollama pull 过的模型）",
        price_in: 0.0,
        price_out: 0.0,
        protocol: Protocol::OpenAi,
    },
    // ===== v6.9 内置免费额度服务商（签到送 token 载体，见 data_store/quota.rs） =====
    // 免用户 key + 免费 + 远程。token 配额计费，与自配服务商完全隔离（见
    // 《PastePanda-签到送Token-规划.md》§10.11）。is_local() 是白名单（ollama），
    // 所以这里不会误判成本地——出网闸与配额检查都会正常生效。
    ProviderSpec {
        id: BUILTIN_AGNES_ID,
        name: "内置免费（Agnes）",
        // 2026-08-11 实测：api.agnes-ai.cn 对该 key 返回 401「无效的令牌」，
        // apihub.agnes-ai.com 200 正常——两域名不互通，用 apihub（用户本地自配同款）。
        base_url: "https://apihub.agnes-ai.com/v1",
        models: models![
            "agnes-2.5-flash" => "免费 · 每日签到送 token",
        ],
        key_url: "",
        note: "内置免费模型：打开即用，送 10 万 token 起步，每天签到领更多（累计到 100 万，兑换码不限）。内容会发送到 Agnes。",
        needs_key: false,
        model_is_free_text: false,
        model_hint: "",
        price_in: 0.0,
        price_out: 0.0,
        protocol: Protocol::OpenAi,
    },
    ProviderSpec {
        id: "openai",
        name: "OpenAI",
        base_url: "https://api.openai.com/v1",
        models: models![
            "gpt-5.6-luna" => "便宜快速（推荐）",
            "gpt-5.6-sol" => "旗舰·更贵",
            "gpt-5.6-terra" => "均衡",
        ],
        key_url: "https://platform.openai.com/api-keys",
        note: "国内直连通常不通，需代理或中转。",
        needs_key: true,
        model_is_free_text: false,
        model_hint: "",
        // luna 是 $0.20/$1.20；sol 单价未知，取偏高值
        price_in: 2.00,
        price_out: 10.00,
        protocol: Protocol::OpenAi,
    },
    ProviderSpec {
        id: "anthropic",
        name: "Anthropic Claude",
        base_url: "https://api.anthropic.com/v1",
        models: models![
            "claude-haiku-4-5" => "便宜快速（推荐）",
            "claude-sonnet-5" => "均衡",
            "claude-opus-5" => "最强·最贵",
        ],
        key_url: "https://console.anthropic.com/settings/keys",
        // 实测（2026-08-08，国内网络）：任何路径都返回 403，是边缘地域封锁，
        // 在鉴权之前就拦了——所以路径本身在这台机器上**无法验证**。
        note: "官方端点国内直连会被地域封锁（403），需代理。国内用 Anthropic 协议通常走智谱等兼容端点或中转。",
        needs_key: true,
        model_is_free_text: false,
        model_hint: "",
        // 默认档 haiku 是 $1/$5；按 opus-5 的 $5/$25 取值，宁可早拦
        price_in: 5.00,
        price_out: 25.00,
        protocol: Protocol::Anthropic,
    },
    ProviderSpec {
        id: "custom",
        name: "自定义 / 中转服务",
        base_url: "",
        models: &[],
        key_url: "",
        note: "任何 OpenAI 兼容的服务。地址填到 /v1 为止。",
        needs_key: true,
        model_is_free_text: true,
        model_hint: "模型名",
        // 价格完全未知，必须不低于表里任何一家（有测试盯着）；
        // 低估会让预算彻底失效，高估只是提前拦一下
        price_in: 5.00,
        price_out: 25.00,
        protocol: Protocol::OpenAi,
    },
];

/// 按 id 查厂商；认不出来就回退默认（不报错）。
pub fn find(id: &str) -> &'static ProviderSpec {
    let key = id.trim().to_ascii_lowercase();
    PROVIDERS
        .iter()
        .find(|p| p.id == key)
        .or_else(|| PROVIDERS.iter().find(|p| p.id == DEFAULT_PROVIDER))
        .expect("厂商表里必须包含默认厂商")
}

/// 支持 OpenAI 兼容 `/embeddings` 的厂商 → 默认 embedding 模型（M5-2 语义索引）。
///
/// 只有查实过接口写法的才列入（与「关思考」同策略：没把握的不画饼）。
/// 返回 `(默认模型, 向量维度)`；`None` = 该厂商没有可用的 embedding 接口
/// （DeepSeek / Kimi / StepFun 等没有，Anthropic 协议也没有）。
pub fn embedding_model_for(provider: &str) -> Option<(&'static str, usize)> {
    match find(provider).id {
        "openai" => Some(("text-embedding-3-small", 1536)),
        "zhipu" => Some(("embedding-3", 2048)),
        "qwen" => Some(("text-embedding-v3", 1024)),
        "siliconflow" => Some(("BAAI/bge-m3", 1024)),
        "volcengine" => Some(("doubao-embedding-text-240715", 2048)),
        "hunyuan" => Some(("hunyuan-embedding", 1024)),
        _ => None,
    }
}

/// AI 配置。**不含 API Key**——Key 在 [`super::secret_store`]，两者存储位置完全分离。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    /// 总开关。默认关；连通性测试通过后由命令层自动置为 true。
    pub enabled: bool,
    /// 厂商 id（见 [`PROVIDERS`]）。
    pub provider: String,
    /// 为空则用厂商默认值；非空时覆盖（中转服务场景）。
    pub base_url: String,
    /// 为空则用厂商默认模型。
    pub model: String,
    /// 日预算上限（**人民币**）。0 表示不限制。
    ///
    /// 存人民币而非美元：国内厂商本来就按人民币计价，给用户看美元没有直觉。
    pub daily_budget_cny: f64,
    /// 单次请求超时（秒）。
    pub timeout_secs: u64,
    /// 向支持的厂商请求“不要思考，直接回答”。
    ///
    /// **默认开**。剪贴板动作绝大多数是短产物（翻译、改写、提要点），
    /// 思维链在这个场景里几乎纯粹是成本：实测一次“精简一半”花掉 13.8 秒与
    /// 1500 输出 token，而答案本身不到 20 字。
    ///
    /// 不支持的厂商上这个开关无效（不发字段），不会报错。
    #[serde(default = "default_true")]
    pub thinking_off: bool,
    /// 接口协议覆盖。为空则用厂商默认。
    ///
    /// 存在的意义：同一家常常两种格式都提供（如智谱），中转服务更是如此。
    #[serde(default)]
    pub protocol: String,
    /// 把用户**手工**标签名当意图上下文拼进 prompt。
    ///
    /// **默认开**。它接的是一类文本里根本判不出来的信息——“这条是要回复的”、
    /// “这条是周报素材”——没它时 ai-reply-draft / ai-weekly-report 这几个动作
    /// 几乎永远推不准。
    ///
    /// 代价必须说清：标签名常含客户名/项目名/人名，开着就会随内容一起发给服务商。
    /// 所以它必须与正文**同过一道出网闸**（见 commands/ai/run.rs），不能绕过。
    ///
    /// 前端不读这个开关：它无条件把标签名传给后端（Tauri IPC 不出本机），
    /// 由后端在这里一处决定用不用——否则“要不要发”的判断会散到多个调用点。
    #[serde(default = "default_true")]
    pub tags_as_context: bool,
    /// 把用户画像压成一段描述拼进 system prompt（D1）。
    ///
    /// **默认开**（用户 2026-08-14 拍定）。它要解的是“四层记忆里只有语义层（画像）
    /// 从未真正改变过 AI 行为”——偏好→prompt、反馈→排序、序列→排序都已经通了，
    /// 就差这一条。默认关的话绝大多数人永远不会开，这个断点等于没修。
    ///
    /// 代价必须说清楚：这是一条**新的出网通道**。以前只有剪贴板正文、手工标签名、
    /// 偏好指令会发给第三方，现在多了一段“你是怎么用这个软件的”。三件事抵消它：
    /// ① 片段是**纯本地固定文案的组合**（见 `ai::profile_prompt`），不含任何剪贴板内容、
    ///   不含自定义动作名、不含任何用户自由输入的字符；
    /// ② 设置页把它**原样展示**出来，用户随时能看到实际发了什么；
    /// ③ 仍然过与正文同一道出网闸（`is_sensitive_for_egress`）。
    ///
    /// 与 `tags_as_context` 一样：**前端不判这个开关**，由后端在 `commands/ai/run.rs`
    /// 一处决定用不用，否则“要不要发”的判断会散到多个调用点。
    #[serde(default = "default_true")]
    pub profile_as_context: bool,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: DEFAULT_PROVIDER.to_string(),
            base_url: String::new(),
            model: String::new(),
            daily_budget_cny: 3.0,
            timeout_secs: 60,
            thinking_off: true,
            protocol: String::new(),
            tags_as_context: true,
            profile_as_context: true,
        }
    }
}

fn default_true() -> bool {
    true
}

impl AiConfig {
    pub fn spec(&self) -> &'static ProviderSpec {
        find(&self.provider)
    }

    /// 实际生效的 base_url（已去尾斜杠）。
    pub fn effective_base_url(&self) -> String {
        let raw = if self.base_url.trim().is_empty() {
            self.spec().base_url
        } else {
            self.base_url.trim()
        };
        raw.trim_end_matches('/').to_string()
    }

    /// 实际生效的模型名。
    pub fn effective_model(&self) -> String {
        if self.model.trim().is_empty() {
            self.spec().default_model().to_string()
        } else {
            self.model.trim().to_string()
        }
    }

    /// 实际生效的协议：用户覆盖优先，否则用厂商默认。
    pub fn effective_protocol(&self) -> Protocol {
        Protocol::from_id(&self.protocol).unwrap_or(self.spec().protocol)
    }

    /// 请求的完整 URL。**两种协议的路径不同**，不能写死。
    pub fn request_url(&self) -> String {
        match self.effective_protocol() {
            Protocol::OpenAi => format!("{}/chat/completions", self.effective_base_url()),
            Protocol::Anthropic => format!("{}/messages", self.effective_base_url()),
        }
    }

    /// 预算上限换算成美元（内部计算统一用美元，因为单价表是美元）。
    pub fn daily_budget_usd(&self) -> f64 {
        if self.daily_budget_cny <= 0.0 {
            0.0
        } else {
            self.daily_budget_cny / USD_TO_CNY
        }
    }

    /// 配置完整性校验——主要拦自定义/聚合平台忘填的情况。
    pub fn validate(&self) -> Result<(), String> {
        if self.effective_base_url().is_empty() {
            return Err("未填写接口地址（Base URL）".to_string());
        }
        if self.effective_model().is_empty() {
            let spec = self.spec();
            return Err(if spec.model_is_free_text && !spec.model_hint.is_empty() {
                format!("未填写模型，例如：{}", spec.model_hint)
            } else {
                "未填写模型名".to_string()
            });
        }
        if self.timeout_secs == 0 {
            return Err("超时时长必须大于 0".to_string());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_agnes_key_reveals_valid_key() {
        // 防误改混淆字节导致还原出坏 key（比如手滑改错一位）
        let k = builtin_agnes_key();
        assert!(k.starts_with("sk-"), "必须以 sk- 开头，实际: {}", &k[..k.len().min(20)]);
        assert_eq!(k.len(), 51, "内置 key 长度必须保持 51");
        assert!(k.bytes().all(|b| b.is_ascii()), "key 必须全 ASCII");
    }

    #[test]
    fn builtin_agnes_uses_working_endpoint() {
        // 2026-08-11 实测：.cn 域名对该 key 401，apihub.agnes-ai.com 200。
        // 防以后有人把域名改回 .cn（那会让整个免费功能全部 401）。
        let spec = PROVIDERS
            .iter()
            .find(|p| p.id == BUILTIN_AGNES_ID)
            .expect("builtin-agnes 必须在预置列表");
        assert!(
            spec.base_url.contains("apihub.agnes-ai.com"),
            "builtin-agnes base_url 必须是 apihub.agnes-ai.com（.cn 实测 401），当前: {}",
            spec.base_url
        );
    }

    #[test]
    fn test_default_is_deepseek_and_disabled() {
        // 默认值必须是国内可直连的厂商，否则用户拿到手第一下就是超时
        let cfg = AiConfig::default();
        assert_eq!(cfg.provider, "deepseek");
        assert!(!cfg.enabled, "AI 必须默认关闭");
        assert_eq!(cfg.request_url(), "https://api.deepseek.com/v1/chat/completions");
        assert_eq!(cfg.effective_model(), "deepseek-v4-flash");
        assert_eq!(cfg.effective_protocol(), Protocol::OpenAi);
    }

    #[test]
    fn test_protocol_decides_path() {
        // 两种协议路径不同，写死任一种都会让另一种 404
        let openai = AiConfig::default();
        assert!(openai.request_url().ends_with("/chat/completions"));

        let claude = AiConfig {
            provider: "anthropic".to_string(),
            ..Default::default()
        };
        assert_eq!(claude.effective_protocol(), Protocol::Anthropic);
        assert!(claude.request_url().ends_with("/messages"));
    }

    #[test]
    fn test_protocol_can_be_overridden_per_config() {
        // 真实场景：智谱既有 OpenAI 格式也有 Anthropic 格式端点，
        // 中转服务更是两套都给——协议不能绑死在厂商上
        let cfg = AiConfig {
            provider: "zhipu".to_string(),
            base_url: "https://open.bigmodel.cn/api/anthropic/v1".to_string(),
            protocol: "anthropic".to_string(),
            model: "glm-4-flash".to_string(),
            ..Default::default()
        };
        assert_eq!(cfg.effective_protocol(), Protocol::Anthropic);
        assert_eq!(
            cfg.request_url(),
            "https://open.bigmodel.cn/api/anthropic/v1/messages"
        );

        // 写了个认不出的协议 → 回退厂商默认，不报错
        let bad = AiConfig {
            protocol: "火星协议".to_string(),
            ..Default::default()
        };
        assert_eq!(bad.effective_protocol(), Protocol::OpenAi);
    }

    #[test]
    fn test_protocol_serializes_as_its_id() {
        // 前端的协议下拉直接消费这个字符串，与 id() 漂移会让选中项落空
        for p in [Protocol::OpenAi, Protocol::Anthropic] {
            let json = serde_json::to_string(&p).unwrap();
            assert_eq!(json, format!("\"{}\"", p.id()));
            assert_eq!(Protocol::from_id(p.id()), Some(p));
        }
    }

    #[test]
    fn test_every_provider_is_well_formed() {
        // 防止新增厂商时漏字段。这张表是手写的，没有编译器帮你检查内容。
        for p in PROVIDERS {
            assert!(!p.id.is_empty(), "id 不能为空");
            assert!(!p.name.is_empty(), "{} 缺 name", p.id);
            assert!(!p.note.is_empty(), "{} 缺 note", p.id);

            if p.id != "custom" {
                assert!(p.base_url.starts_with("http"), "{} 的 base_url 不合法", p.id);
                assert!(!p.base_url.ends_with('/'), "{} 的 base_url 不该带尾斜杠", p.id);
            }

            // 不给下拉清单的，必须允许自由输入并给出提示，否则用户无从下手
            if p.models.is_empty() {
                assert!(p.model_is_free_text, "{} 无模型清单却不允许自由输入", p.id);
                assert!(!p.model_hint.is_empty(), "{} 需要自由输入却没给提示", p.id);
            }

            // 需要密钥的必须告诉用户去哪申请——这是国内用户最大的卡点
            if p.needs_key && p.id != "custom" {
                assert!(p.key_url.starts_with("http"), "{} 缺申请 Key 的链接", p.id);
            }

            assert!(p.price_in >= 0.0 && p.price_out >= 0.0, "{} 单价不能为负", p.id);
        }
    }

    #[test]
    fn test_listed_models_are_usable_as_default() {
        // 模型芯片现在在主流程里，第一项就是用户不动手时用的那个，
        // 它必须真能当模型名发出去（非空、无空白）
        for p in PROVIDERS.iter().filter(|p| !p.models.is_empty()) {
            let d = p.default_model();
            assert!(!d.is_empty(), "{} 的默认模型为空", p.id);
            assert_eq!(d.trim(), d, "{} 的默认模型带空白", p.id);
            for m in p.models {
                assert!(!m.id.is_empty(), "{} 有空模型 id", p.id);
                assert!(!m.label.is_empty(), "{} 的 {} 缺档位说明", p.id, m.id);
            }
        }

        // 模型名里不得带空格（拷贝时容易带进来，会直接导致 404）
        for p in PROVIDERS {
            for m in p.models {
                assert!(!m.id.contains(' '), "{} 的模型 {} 带空格", p.id, m.id);
            }
        }
    }

    #[test]
    fn test_provider_ids_are_unique() {
        let mut ids: Vec<&str> = PROVIDERS.iter().map(|p| p.id).collect();
        let total = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), total, "厂商 id 有重复");
    }

    #[test]
    fn test_unknown_provider_falls_back_to_default() {
        assert_eq!(find("乱写的").id, "deepseek");
        assert_eq!(find("").id, "deepseek");
        assert_eq!(find("DeepSeek").id, "deepseek", "大小写不敏感");
    }

    #[test]
    fn test_ollama_is_local_and_keyless() {
        // Ollama 是唯一不需密钥、零费用的选项，界面要据此隐藏密钥与预算
        let o = find("ollama");
        assert!(!o.needs_key);
        assert!(o.is_local());
        assert_eq!(o.price_in, 0.0);

        // 其他厂商都不能被当成本地
        for p in PROVIDERS.iter().filter(|p| p.id != "ollama") {
            assert!(!p.is_local(), "{} 不应被当成本地厂商", p.id);
        }
    }

    #[test]
    fn test_volcengine_uses_endpoint_id_not_model_name() {
        // 火山方舟填的是推理接入点 ID，给模型下拉会让用户必然填错
        let v = find("volcengine");
        assert!(v.model_is_free_text);
        assert!(v.models.is_empty());
        assert!(v.model_hint.contains("ep-"));
    }

    #[test]
    fn test_custom_requires_explicit_config() {
        let mut cfg = AiConfig {
            provider: "custom".to_string(),
            ..Default::default()
        };
        assert!(cfg.validate().is_err(), "custom 缺 base_url 应报错");

        cfg.base_url = "https://my.llm/v1".to_string();
        let err = cfg.validate().unwrap_err();
        assert!(err.contains("模型"), "缺模型时应提示模型，实际：{}", err);

        cfg.model = "my-model".to_string();
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn test_base_url_override_strips_trailing_slash() {
        let cfg = AiConfig {
            base_url: "  https://proxy.example.com/v1/  ".to_string(),
            ..Default::default()
        };
        // 尾斜杠要去掉，否则拼出 //chat/completions
        assert_eq!(cfg.request_url(), "https://proxy.example.com/v1/chat/completions");
    }

    #[test]
    fn test_budget_cny_to_usd() {
        let cfg = AiConfig {
            daily_budget_cny: 7.2,
            ..Default::default()
        };
        assert!((cfg.daily_budget_usd() - 1.0).abs() < 1e-9);

        // 0 表示不限制，不要除出个小数
        let unlimited = AiConfig {
            daily_budget_cny: 0.0,
            ..Default::default()
        };
        assert_eq!(unlimited.daily_budget_usd(), 0.0);
    }
}
