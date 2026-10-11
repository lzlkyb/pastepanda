#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>
#include <assert.h>
#include <string.h>
static bool interaction;
static int calls, sets;
static OSStatus reply, policyReply;
static size_t resultLength=32;
static OSStatus fakePolicy(Boolean allow) {
    sets++; if(policyReply) return policyReply;
    interaction=allow; return 0;
}
static OSStatus fakeRead(CFDictionaryRef query, CFTypeRef *result) {
    calls++; NSDictionary *q=(__bridge NSDictionary *)query;
    assert([q[(__bridge id)kSecAttrService] isEqual:@"com.pastepanda.app.encryption"]);
    assert([q[(__bridge id)kSecAttrAccount] isEqual:@"local-key-v1"]);
    assert([q[(__bridge id)kSecUseAuthenticationUI] isEqual:(__bridge id)(interaction?kSecUseAuthenticationUIAllow:kSecUseAuthenticationUIFail)]);
    LAContext *context=q[(__bridge id)kSecUseAuthenticationContext];
    assert(interaction ? context==nil : context.interactionNotAllowed);
    if(reply) return reply;
    NSMutableData *data=[NSMutableData dataWithLength:resultLength];
    memset(data.mutableBytes,7,resultLength); *result=CFBridgingRetain(data); return 0;
}
static OSStatus fakeCreate(CFDictionaryRef query, CFTypeRef *result) {
    assert(!interaction); calls++; return reply;
}
#define SecKeychainSetUserInteractionAllowed fakePolicy
#define SecItemCopyMatching fakeRead
#define SecItemAdd fakeCreate
#include "keychain_functions.inc"
int main(void) { @autoreleasepool {
    uint8_t key[32]={0};
    reply=errSecAuthFailed;
    assert(pp_mac_keychain_read(key,32)==errSecAuthFailed && !interaction);
    reply=0; calls=sets=0;
    assert(pp_mac_keychain_authorize(key,32)==0 && key[0]==7 && !interaction && sets==2 && calls==1);
    for(int i=0;i<3;i++) {
        reply=(OSStatus[]){errSecAuthFailed,errSecUserCanceled,errSecItemNotFound}[i];
        calls=sets=0; memset(key,0,32);
        assert(pp_mac_keychain_authorize(key,32)==reply && key[0]==0 && !interaction && calls==1 && sets==2);
    }
    reply=0; resultLength=31;
    assert(pp_mac_keychain_authorize(key,32)==errSecDecode && !interaction);
    resultLength=32; policyReply=errSecAuthFailed; calls=0;
    assert(pp_mac_keychain_authorize(key,32)==errSecAuthFailed && calls==0);
    policyReply=0; assert(pp_mac_keychain_authorize(key,31)==errSecParam);
    puts("PASS: explicit authorization reads only the existing key; success, cancellation, denial and malformed data all restore noninteractive policy (mock Security, no real key accessed)");
    return 0;
}}
