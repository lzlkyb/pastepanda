// Real encoding of owned fixture pixels, including decoder recovery. No desktop
// capture or audio devices. Optional IVF is decoded independently by FFmpeg.
#include "../av1_bridge.h"
#include <assert.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/resource.h>
#include <unistd.h>
static void little(FILE *file, uint64_t value, unsigned bytes) {
    for (unsigned i = 0; i < bytes; i++) fputc((value >> (8 * i)) & 255, file);
}
static double seconds(void) {
    struct timespec at; clock_gettime(CLOCK_MONOTONIC, &at);
    return at.tv_sec + at.tv_nsec / 1e9;
}
int main(int argc, char **argv) {
    assert(argc >= 2);
    void *library = dlopen(argv[1], RTLD_LOCAL | RTLD_NOW);
    if (!library) { fprintf(stderr, "%s\n", dlerror()); return 2; }
    uint32_t (*abi)(void) = dlsym(library, "pp_av1_abi");
    int32_t (*open_encoder)(uint32_t,uint32_t,uint32_t,uint32_t,void**) = dlsym(library,"pp_av1_open");
    int32_t (*encode)(void*,const uint8_t*,size_t,bool,int64_t,PPAv1Packet*) = dlsym(library,"pp_av1_encode");
    void (*close_encoder)(void*) = dlsym(library,"pp_av1_close");
    void (*free_packet)(uint8_t*) = dlsym(library,"pp_av1_free");
    assert(abi && abi() == 1 && open_encoder && encode && close_encoder && free_packet);
    void *session = NULL;
    assert(open_encoder(3840,2160,60,8000000,&session) != 0 && session == NULL);
    assert(open_encoder(65,64,30,1000000,&session) != 0 && session == NULL);
    unsigned w = argc > 3 ? atoi(argv[3]) : 64;
    unsigned h = w == 1920 ? 1080 : w == 1280 ? 720 : 64;
    assert(open_encoder(w,h,30,8000000,&session) == 0 && session);
    FILE *ivf = argc > 2 ? fopen(argv[2],"wb") : NULL;
    FILE *recovery = NULL; char recovery_path[4096];
    if (argc > 2) { assert(snprintf(recovery_path,sizeof(recovery_path),"%s.recovery.ivf",argv[2]) < sizeof(recovery_path)); recovery = fopen(recovery_path,"wb"); assert(recovery); }
    if (argc > 2) assert(ivf);
    if (ivf) {
        fwrite("DKIF",1,4,ivf); little(ivf,0,2); little(ivf,32,2); fwrite("AV01",1,4,ivf);
        little(ivf,w,2); little(ivf,h,2); little(ivf,1000,4); little(ivf,1,4);
        little(ivf,0,4); little(ivf,0,4);
        fwrite("DKIF",1,4,recovery); little(recovery,0,2); little(recovery,32,2); fwrite("AV01",1,4,recovery);
        little(recovery,w,2); little(recovery,h,2); little(recovery,1000,4); little(recovery,1,4); little(recovery,0,4); little(recovery,0,4);
    }
    size_t size = (size_t)w*h*4; uint8_t *pixels = malloc(size); assert(pixels);
    PPAv1Packet invalid = {0};
    assert(encode(session,pixels,size-1,true,0,&invalid) != 0 && !invalid.data);
    unsigned packets = 0, keyframes = 0; bool first_key = false, forced_key = false;
    int64_t last_at = -1; double encoding = 0, maximum = 0;
    for (unsigned i = 0; i < 30; i++) {
        for (unsigned y = 0; y < h; y++) for (unsigned x = 0; x < w; x++) {
            size_t n = ((size_t)y*w+x)*4;
            pixels[n] = (x+i*9)%256; pixels[n+1] = (y+i*5)%256;
            pixels[n+2] = (x/16+y/16+i)*13%256; pixels[n+3] = 255;
        }
        PPAv1Packet packet = {0}; double start = seconds();
        int status = encode(session,pixels,size,i==0 || i==15,(int64_t)i*34,&packet);
        double duration = seconds()-start; encoding += duration;
        if (duration > maximum) maximum = duration;
        if (status != 0 && status != 10) { fprintf(stderr,"encode failed %d at frame %u\n",status,i); return 3; }
        if (status == 0) {
            assert(packet.data && packet.length && packet.at_ms > last_at);
            if (!packets) first_key = packet.key;
            if (packet.key) { keyframes++; if (packet.at_ms == 510) forced_key = true; }
            last_at = packet.at_ms; packets++;
            if (ivf) { little(ivf,packet.length,4); little(ivf,packet.at_ms,8); fwrite(packet.data,1,packet.length,ivf); }
            if (recovery && packet.at_ms >= 510) { little(recovery,packet.length,4); little(recovery,packet.at_ms-510,8); fwrite(packet.data,1,packet.length,recovery); }
            free_packet(packet.data);
        } else assert(!packet.data && packet.length == 0);
        // Simulate delivery cadence so worker threads get CPU between frames.
        usleep(34000);
    }
    assert(packets >= 20 && first_key && forced_key && keyframes >= 2);
    assert(encode(session,pixels,size,false,0,&invalid) != 0 && !invalid.data);
    if (ivf) { fseek(ivf,24,SEEK_SET); little(ivf,packets,4); assert(fclose(ivf)==0); }
    if (recovery) assert(fclose(recovery)==0);
    close_encoder(session); free(pixels); dlclose(library);
    struct rusage usage; getrusage(RUSAGE_SELF, &usage);
    printf("PASS: actual FFmpeg/SVT-AV1 %ux%u, %u packets, %u keys including forced key at 510ms; mean call %.2fms, max %.2fms, peak RSS %.1f MiB (owned pixels, paced input; not live capture FPS)\n",w,h,packets,keyframes,encoding*1000/30,maximum*1000,usage.ru_maxrss/1048576.);
    return 0;
}
