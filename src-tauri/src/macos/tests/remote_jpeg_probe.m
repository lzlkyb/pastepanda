#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#include <assert.h>
#include <stdint.h>
extern int32_t pp_rc_jpeg(const uint8_t *,size_t,uint32_t,uint32_t,uint8_t,uint8_t **,size_t *);
int main(){@autoreleasepool{
    uint32_t w=1280,h=720;size_t n=(size_t)w*h*3;uint8_t *rgb=malloc(n);for(size_t i=0;i<n;i+=3){rgb[i]=240;rgb[i+1]=20;rgb[i+2]=10;}
    uint8_t *out=NULL;size_t size=0;assert(pp_rc_jpeg(rgb,n,w,h,90,&out,&size)==0 && size>0);
    NSBitmapImageRep *image=[[NSBitmapImageRep alloc] initWithData:[NSData dataWithBytes:out length:size]];assert(image.pixelsWide==w && image.pixelsHigh==h);NSColor *pixel=[[image colorAtX:640 y:360] colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];assert(pixel.redComponent>.85 && pixel.blueComponent<.15);free(out);
    double started=NSDate.date.timeIntervalSince1970;
    for(int i=0;i<10;i++){assert(pp_rc_jpeg(rgb,n,w,h,80,&out,&size)==0);free(out);}
    printf("PASS: native JPEG dimensions and RGB channels; 1280x720 uniform frame ten-encode mean %.2f ms (encoding only, no capture/network)\n",(NSDate.date.timeIntervalSince1970-started)*100);
    assert(pp_rc_jpeg(rgb,1,w,h,80,&out,&size)==1 && !out);assert(pp_rc_jpeg(rgb,n,UINT32_MAX,UINT32_MAX,80,&out,&size)==1);free(rgb);
}return 0;}
