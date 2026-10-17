#include "mnn_bert_probe.h"

#include <MNN/Interpreter.hpp>
#include <MNN/Tensor.hpp>
#include <MNN/MNNDefine.h>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

namespace
{

struct BertEngine
{
    std::unique_ptr<MNN::Interpreter> interpreter;
    MNN::Session* session = nullptr;
    std::vector<std::string> input_names;
    std::string output_name;
    int dim = 0;
};

// halide_type_t.code：0=float 1=int 2=uint（HalideRuntime.h）
// 按 tensor 真实 dtype 写入，避免把 token id 当 float 塞进去。
bool write_input(MNN::Tensor* t, const long long* data, int n)
{
    auto type = t->getType();
    if (type.code == 1)
    {
        if (type.bits == 32)
        {
            auto* p = t->host<int32_t>();
            for (int i = 0; i < n; i++) p[i] = static_cast<int32_t>(data[i]);
            return true;
        }
        if (type.bits == 64)
        {
            auto* p = t->host<int64_t>();
            for (int i = 0; i < n; i++) p[i] = static_cast<int64_t>(data[i]);
            return true;
        }
    }
    else if (type.code == 0 && type.bits == 32)
    {
        // 万一转换把输入变成了 float：仍然写数值（token id 数值可被 float32 精确表示
        // 到 2^24，BGE 词表 21128 以内无损）。
        auto* p = t->host<float>();
        for (int i = 0; i < n; i++) p[i] = static_cast<float>(data[i]);
        return true;
    }
    return false;
}

} // namespace

extern "C" int mnn_bert_load(const char* model_path, void** out_engine, char* err, int err_len)
{
    auto set_err = [&](const char* msg)
    {
        if (err && err_len > 0) std::snprintf(err, err_len, "%s", msg);
    };
    if (!model_path || !out_engine)
    {
        set_err("null arg");
        return 1;
    }
    auto* engine = new BertEngine();
    engine->interpreter.reset(MNN::Interpreter::createFromFile(model_path));
    if (!engine->interpreter)
    {
        set_err("createFromFile failed");
        delete engine;
        return 2;
    }
    MNN::ScheduleConfig cfg;
    cfg.type = MNN_FORWARD_CPU;
    cfg.numThread = 4;
    engine->session = engine->interpreter->createSession(cfg);
    if (!engine->session)
    {
        set_err("createSession failed");
        delete engine;
        return 3;
    }
    auto inputs = engine->interpreter->getSessionInputAll(engine->session);
    for (auto& kv : inputs) engine->input_names.push_back(kv.first);
    auto outputs = engine->interpreter->getSessionOutputAll(engine->session);
    if (outputs.empty())
    {
        set_err("no output");
        delete engine;
        return 4;
    }
    // 优先按名取 last_hidden_state；没有就退第一个输出。
    auto it = outputs.find("last_hidden_state");
    engine->output_name = (it != outputs.end()) ? it->first : outputs.begin()->first;
    auto* out = engine->interpreter->getSessionOutput(engine->session, engine->output_name.c_str());
    auto shape = out->shape();
    if (shape.size() == 3) engine->dim = shape[2];

    *out_engine = engine;
    return 0;
}

extern "C" int mnn_bert_run(void* engine_handle,
                            const long long* input_ids,
                            const long long* attention_mask,
                            const long long* token_type_ids,
                            int seq_len,
                            int dim,
                            float* out_embedding,
                            char* err,
                            int err_len)
{
    auto set_err = [&](const char* msg)
    {
        if (err && err_len > 0) std::snprintf(err, err_len, "%s", msg);
    };
    auto* engine = static_cast<BertEngine*>(engine_handle);
    if (!engine || !engine->session)
    {
        set_err("null engine");
        return 1;
    }

    // 动态 seq：resize 三个输入再 resizeSession，之后重新取 tensor 指针。
    std::vector<int> shape = {1, seq_len};
    struct InSpec
    {
        const char* name;
        const long long* data;
    } specs[3] = {
        {"input_ids", input_ids},
        {"attention_mask", attention_mask},
        {"token_type_ids", token_type_ids},
    };
    std::vector<MNN::Tensor*> tensors;
    for (auto& s : specs)
    {
        auto inputs = engine->interpreter->getSessionInputAll(engine->session);
        auto it = inputs.find(s.name);
        if (it == inputs.end())
        {
            set_err((std::string("missing input: ") + s.name).c_str());
            return 2;
        }
        MNN::Tensor* t = it->second;
        engine->interpreter->resizeTensor(t, shape);
        tensors.push_back(t);
    }
    engine->interpreter->resizeSession(engine->session);

    // resize 后指针可能失效，重新取一遍再写。
    for (int i = 0; i < 3; i++)
    {
        auto inputs = engine->interpreter->getSessionInputAll(engine->session);
        tensors[i] = inputs.find(specs[i].name)->second;
        if (!write_input(tensors[i], specs[i].data, seq_len))
        {
            set_err((std::string("unsupported input dtype: ") + specs[i].name).c_str());
            return 3;
        }
    }

    auto code = engine->interpreter->runSession(engine->session);
    if (code != MNN::NO_ERROR)
    {
        set_err("runSession failed");
        return 4;
    }

    auto* out = engine->interpreter->getSessionOutput(engine->session, engine->output_name.c_str());
    if (!out)
    {
        set_err("getSessionOutput failed");
        return 5;
    }
    // 不能直接 out->host<float>()：图内输出 tensor 是 NC4HW4 内部布局，直读是乱码
    // （实测 cos 全在 0.1 上下 + 一堆 NaN）。按 ocr-rs 同款手法包一层 host tensor
    // 再 copyToHostTensor；hidden state 是 [1, seq, dim]，用 TENSORFLOW（NHWC）保持
    // seq-major 行序（ocr-rs 的 CAFFE 是给它 4D 检测图用的）。
    std::shared_ptr<MNN::Tensor> host_out(new MNN::Tensor(out, MNN::Tensor::TENSORFLOW));
    out->copyToHostTensor(host_out.get());
    // shape 向量报的是 MNN 内部 4D 化的维序（[N,C,W]，如 1 512 106），
    // 不能按 shape[2]==dim 校验。TENSORFLOW host 布局的内存是 [seq][dim] 行主序，
    // 用总元素数校验即可。
    auto oshape = host_out->shape();
    size_t total = 1;
    for (int v : oshape) total *= (size_t)v;
    if (total != (size_t)seq_len * (size_t)dim)
    {
        std::string s = "unexpected output shape:";
        for (int v : oshape) s += " " + std::to_string(v);
        set_err(s.c_str());
        return 6;
    }
    const float* hidden = host_out->host<float>();

    // BGE 官方 pooling：取 CLS（第 0 个 token）的 hidden state，再 L2 归一化。
    // fastembed 对 BGESmallZHV15 的默认 pooling 也是 Cls（src/text_embedding/impl.rs
    // get_default_pooling_method），两侧口径一致，余弦对比才成立。
    // （此前误写 mean pooling——那是 E5 系的做法，BGE v1.5 是 CLS。）
    if (attention_mask[0] == 0)
    {
        set_err("CLS token masked out");
        return 7;
    }
    const float* cls = hidden; // seq 0, dim 列连续
    double norm = 0.0;
    for (int d = 0; d < dim; d++)
    {
        out_embedding[d] = cls[d];
        norm += (double)cls[d] * cls[d];
    }
    norm = std::sqrt(norm);
    if (norm > 0)
    {
        for (int d = 0; d < dim; d++) out_embedding[d] = (float)(out_embedding[d] / norm);
    }
    return 0;
}

extern "C" int mnn_bert_report(void* engine_handle, char* buf, int buf_len)
{
    auto* engine = static_cast<BertEngine*>(engine_handle);
    if (!engine || !buf || buf_len <= 0) return 1;
    std::string s = "inputs:";
    for (auto& n : engine->input_names) s += " " + n;
    s += " | output: " + engine->output_name + " dim=" + std::to_string(engine->dim);
    std::snprintf(buf, buf_len, "%s", s.c_str());
    return 0;
}

extern "C" void mnn_bert_unload(void* engine)
{
    if (!engine) return;
    auto* e = static_cast<BertEngine*>(engine);
    if (e->session && e->interpreter)
    {
        e->interpreter->releaseSession(e->session);
    }
    delete e;
}
