// Owned IVF fixture only. No device/network/clipboard access.
#include "../av1_bridge.h"
#include <assert.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/resource.h>
static uint64_t little(FILE *f, unsigned n) {
    uint64_t v = 0;
    for (unsigned i = 0; i < n; i++) { int b = fgetc(f); assert(b != EOF); v |= (uint64_t)b << (i * 8); }
    return v;
}
static double seconds(void) {
    struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec + t.tv_nsec / 1e9;
}
int main(int argc, char **argv) {
    assert(argc == 3);
    void *lib = dlopen(argv[1], RTLD_LOCAL | RTLD_NOW); assert(lib);
    int32_t (*open)(void**) = dlsym(lib, "pp_av1_decode_open");
    int32_t (*decode)(void*,const uint8_t*,size_t,int64_t,PPAv1Picture*) = dlsym(lib,"pp_av1_decode");
    void (*close)(void*) = dlsym(lib, "pp_av1_decode_close");
    void (*release)(uint8_t*) = dlsym(lib, "pp_av1_free");
    assert(open && decode && close && release);
    void *session = NULL; assert(open(&session) == 0 && session);
    PPAv1Picture bad = {0}; uint8_t invalid[] = {255,255,255};
    assert(decode(session, invalid, 0, 0, &bad) != 0 && !bad.data);
    assert(decode(session, invalid, 8 * 1024 * 1024 + 1, 0, &bad) != 0 && !bad.data);
    assert(decode(session, invalid, sizeof(invalid), 0, &bad) != 0 && !bad.data);
    close(session); assert(open(&session) == 0);
    FILE *f = fopen(argv[2], "rb"); assert(f);
    assert(little(f,4) == 0x46494b44); assert(little(f,2) == 0); assert(little(f,2) == 32);
    assert(little(f,4) == 0x31305641);
    unsigned w = little(f,2), h = little(f,2);
    fseek(f,32,SEEK_SET);
    unsigned frames = 0; double total = 0, maximum = 0, error = 0;
    uint64_t prev = 0; bool changing = false;
    struct rusage before; getrusage(RUSAGE_SELF, &before);
    while (fgetc(f) != EOF) {
        fseek(f,-1,SEEK_CUR);
        size_t size = little(f,4); int64_t at = little(f,8);
        assert(size && size <= 8 * 1024 * 1024);
        uint8_t *packet = malloc(size); assert(packet); assert(fread(packet,1,size,f) == size);
        PPAv1Picture picture = {0}; double start = seconds();
        assert(decode(session,packet,size,at,&picture) == 0);
        double duration = seconds() - start; total += duration; if (duration > maximum) maximum = duration;
        assert(picture.width == w && picture.height == h && picture.length == (size_t)w*h*4);
        assert(picture.data && picture.at_ms == at);
        uint64_t hash = 0; double diff = 0;
        // RGB error sampled away from discontinuities in the owned fixture.
        unsigned i = (unsigned)at / 34 + (strstr(argv[2], "recovery") ? 15 : 0);
        for (unsigned y=0; y<h; y+=17) for (unsigned x=0; x<w; x+=17) {
            size_t n = ((size_t)y*w+x)*4; uint8_t *p = picture.data+n;
            assert(p[3] == 255);
            hash = hash*131+p[0]+p[1]*3+p[2]*7;
            diff += abs((int)p[0]-(int)((x+i*9)%256));
            diff += abs((int)p[1]-(int)((y+i*5)%256));
            diff += abs((int)p[2]-(int)((x/16+y/16+i)*13%256));
        }
        error += diff / (((w+16)/17)*((h+16)/17)*3);
        if (frames && hash != prev) changing = true; prev = hash;
        frames++; release(picture.data); free(packet);
    }
    assert(frames >= 8 && changing);
    assert(error / frames < 25);
    struct rusage after; getrusage(RUSAGE_SELF, &after);
    double cpu = after.ru_utime.tv_sec-before.ru_utime.tv_sec + (after.ru_utime.tv_usec-before.ru_utime.tv_usec)/1e6 +
        after.ru_stime.tv_sec-before.ru_stime.tv_sec + (after.ru_stime.tv_usec-before.ru_stime.tv_usec)/1e6;
    printf("PASS: dav1d %ux%u, %u changing RGBA frames, mean %.2fms max %.2fms CPU %.2fms/frame, RGB mean error %.2f, raw IPC %.2f MiB/frame; fixture decode+conversion only\n",
        w,h,frames,total*1000/frames,maximum*1000,cpu*1000/frames,error/frames,w*h*4./1048576.);
    fclose(f); close(session); dlclose(lib);
    return 0;
}
