class MonAgentCompanyInfo extends AIInfo {
    function GetAuthor()      { return "MonAgent"; }
    function GetName()        { return "MonAgent Company"; }
    function GetDescription() { return "Passive company owner controlled through the MonAgent GameScript bridge."; }
    function GetVersion()     { return 1; }
    function MinVersionToLoad(){ return 1; }
    function GetDate()        { return "2026-08-07"; }
    function CreateInstance() { return "MonAgentCompany"; }
    function GetShortName()   { return "MAAI"; }
    function GetAPIVersion()  { return "15"; }
}

RegisterAI(MonAgentCompanyInfo());
