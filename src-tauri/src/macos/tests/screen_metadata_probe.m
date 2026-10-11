#import <Foundation/Foundation.h>
#include <assert.h>
#include "../screen.m"
int32_t pp_mac_capture_legacy(uint32_t display,uint32_t width,uint32_t height,uint8_t **output,size_t *length){return 8;}
bool pp_mac_target_valid(int32_t pid,uint32_t own){return false;}
int main(){@autoreleasepool{
    uint8_t *data=NULL;size_t length=0;assert(pp_mac_monitors(&data,&length)==0 && data && length);
    NSArray *list=[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:data length:length] options:0 error:nil];free(data);
    assert([list isKindOfClass:NSArray.class] && list.count>0);BOOL primary=NO;
    for(NSDictionary *monitor in list){
        assert(CFGetTypeID((__bridge CFTypeRef)monitor[@"primary"])==CFBooleanGetTypeID());
        assert([monitor[@"w"] intValue]>0 && [monitor[@"h"] intValue]>0 && [monitor[@"displayId"] unsignedIntValue]>0);
        assert([monitor[@"scale"] doubleValue]>0);primary|=[monitor[@"primary"] boolValue];
    }
    assert(primary);
    puts("PASS: actual display metadata has boolean primary flags, stable IDs and valid common-density geometry (no screen capture or input)");return 0;
}}
