#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
@interface PPWebVideoProbe:NSObject<WKNavigationDelegate,WKScriptMessageHandler>
@property WKWebView *web;
@property NSString *script;
@property BOOL done,passed;
@end
@implementation PPWebVideoProbe
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message{
    if(![message.body isKindOfClass:NSString.class])return;
    puts([message.body UTF8String]);NSDictionary *result=[NSJSONSerialization JSONObjectWithData:[message.body dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    self.passed=[result[@"avcFrames"] intValue]==4 && [result[@"colorsOK"] boolValue] && [result[@"audioFrames"] intValue]>0 && [result[@"audioPeak"] doubleValue]>.05;self.done=YES;
}
- (void)webView:(WKWebView *)web didFinishNavigation:(WKNavigation *)navigation{
    [web evaluateJavaScript:self.script completionHandler:^(id result,NSError *error){if(error){fprintf(stderr,"WebKit video fixture failed: %s\n",error.localizedDescription.UTF8String);self.done=YES;}}];
}
@end
int main(int argc,char **argv){@autoreleasepool{
    if(argc!=3)return 2;NSData *fixtures=[NSData dataWithContentsOfFile:[NSString stringWithUTF8String:argv[1]]];
    NSArray *items=fixtures?[NSJSONSerialization JSONObjectWithData:fixtures options:0 error:nil]:nil;if(![items isKindOfClass:NSArray.class])return 2;
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    PPWebVideoProbe *probe=[PPWebVideoProbe new];WKWebViewConfiguration *config=[WKWebViewConfiguration new];
    [config.userContentController addScriptMessageHandler:probe name:@"result"];
    probe.web=[[WKWebView alloc] initWithFrame:NSMakeRect(0,0,64,64) configuration:config];probe.web.navigationDelegate=probe;
    NSString *json=[[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:items options:0 error:nil] encoding:NSUTF8StringEncoding];
    NSString *audio=[[NSString alloc] initWithData:[NSData dataWithContentsOfFile:[NSString stringWithUTF8String:argv[2]]] encoding:NSUTF8StringEncoding];if(!audio)return 2;
    NSString *body=@"(async()=>{const result={secure:isSecureContext,avcFrames:0,hevcFrames:0,audioFrames:0,audioPeak:0,colorsOK:true,errors:[]};try{for(const codec of [...new Set(items.map(x=>x.codec))]){const frames=items.filter(x=>x.codec===codec);const cfg={codec,codedWidth:64,codedHeight:64,optimizeForLatency:true};const support=await VideoDecoder.isConfigSupported(cfg);if(!support.supported){result.errors.push(codec+': unsupported');continue;}const canvas=document.createElement('canvas');canvas.width=canvas.height=64;const ctx=canvas.getContext('2d');const decoder=new VideoDecoder({output:f=>{try{ctx.drawImage(f,0,0);const p=ctx.getImageData(32,32,1,1).data;result.colorsOK=result.colorsOK&&Math.abs(p[0]-190)<35&&Math.abs(p[1]-40)<35&&Math.abs(p[2]-20)<35;result[codec.startsWith('avc1.')?'avcFrames':'hevcFrames']++;}finally{f.close();}},error:e=>result.errors.push(codec+': '+e.message)});try{decoder.configure(cfg);for(const f of frames){const bytes=Uint8Array.from(atob(f.data),c=>c.charCodeAt(0));decoder.decode(new EncodedVideoChunk({type:f.key?'key':'delta',timestamp:f.timestamp,data:bytes}));}await decoder.flush();}finally{decoder.close();}}const audio=new AudioDecoder({output:f=>{try{const samples=new Float32Array(f.numberOfFrames);f.copyTo(samples,{planeIndex:0,format:'f32-planar'});for(const x of samples)result.audioPeak=Math.max(result.audioPeak,Math.abs(x));result.audioFrames+=f.numberOfFrames;}finally{f.close();}},error:e=>result.errors.push('aac: '+e.message)});try{audio.configure({codec:'mp4a.40.2',sampleRate:48000,numberOfChannels:2,description:new Uint8Array([0x11,0x90])});for(const f of audioItems)audio.decode(new EncodedAudioChunk({type:'key',timestamp:f.timestamp,data:Uint8Array.from(atob(f.data),c=>c.charCodeAt(0))}));await audio.flush();}finally{audio.close();}}catch(e){result.errors.push(String(e));}window.webkit.messageHandlers.result.postMessage(JSON.stringify(result));})()";
    // Returning undefined avoids WKWebView's unsupported Promise return value.
    probe.script=[NSString stringWithFormat:@"(()=>{const items=%@;const audioItems=%@;%@;})()",json,audio,body];
    [probe.web loadHTMLString:@"<!doctype html><html><body>Native codec fixture</body></html>" baseURL:[NSURL URLWithString:@"https://localhost/"]];
    NSDate *deadline=[NSDate dateWithTimeIntervalSinceNow:12];while(!probe.done && deadline.timeIntervalSinceNow>0)[NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:.1]];
    [config.userContentController removeScriptMessageHandlerForName:@"result"];
    if(!probe.done){fputs("WebKit video fixture timed out\n",stderr);return 2;}return probe.passed?0:1;
}}
