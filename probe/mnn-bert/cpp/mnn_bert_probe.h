#pragma once

#ifdef __cplusplus
extern "C" {
#endif

// A2 探针专用 wrapper（有意重写，不复用 ocr-rs 的 mnn_wrapper.cpp——那个只取
// 第一个输入且只吃 float，见 README 的局限表）。职责收窄到一件事：
// 「多输入 + int dtype + 按名取输出」地跑通一个 BERT 类模型，返回 CLS-pooled
// 且 L2 归一化的句向量（BGE v1.5 官方 pooling = CLS，fastembed 同款）。

// 加载模型。成功返回 0，*out_engine 非空；失败写 err 并返回非 0。
int mnn_bert_load(const char* model_path, void** out_engine, char* err, int err_len);

// 跑一次前向。三个输入等长 seq_len；out_embedding 至少 dim 个 float。
// 成功返回 0。
int mnn_bert_run(void* engine,
                 const long long* input_ids,
                 const long long* attention_mask,
                 const long long* token_type_ids,
                 int seq_len,
                 int dim,
                 float* out_embedding,
                 char* err,
                 int err_len);

// 查询加载后报告的输入/输出信息（形状与 dtype），用于探针记录。
int mnn_bert_report(void* engine, char* buf, int buf_len);

void mnn_bert_unload(void* engine);

#ifdef __cplusplus
}
#endif
