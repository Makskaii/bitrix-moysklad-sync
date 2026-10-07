param(
    [string] $CredentialFile = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) '.env')
)

$ErrorActionPreference = 'Stop'

function Read-EnvValue([string] $path, [string] $key) {
    $line = Get-Content -LiteralPath $path | Where-Object { $_ -match "^\s*$([regex]::Escape($key))=" } | Select-Object -First 1
    if (-not $line) { throw "Missing credential key: $key" }
    return ($line -replace "^\s*$([regex]::Escape($key))=", '').Trim().Trim('"').Trim("'")
}

function Invoke-BitrixGet([string] $method, [hashtable] $parameters = @{}) {
    $allowed = @('catalog.measure.list', 'catalog.priceType.list', 'crm.deal.userfield.list', 'lists.element.get')
    if ($method -notin $allowed) { throw 'Bitrix method is not allowlisted.' }

    $pairs = [System.Collections.Generic.List[string]]::new()
    foreach ($entry in $parameters.GetEnumerator()) {
        $values = @($entry.Value)
        for ($i = 0; $i -lt $values.Count; $i++) {
            $key = [string]$entry.Key
            if ($values.Count -gt 1) { $key = "${key}[$i]" }
            $pairs.Add(([uri]::EscapeDataString($key) + '=' + [uri]::EscapeDataString([string]$values[$i])))
        }
    }
    $url = $script:BitrixBase + $method + '.json'
    if ($pairs.Count) { $url += '?' + ($pairs -join '&') }
    $uri = [uri]$url
    if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'aerosystems.bitrix24.ru' -or $uri.AbsolutePath -notmatch '^/rest/\d+/[^/]+/') {
        throw 'Bitrix endpoint failed the host/path guard.'
    }
    try { return Invoke-RestMethod -Method Get -Uri $uri -Headers @{ Accept = 'application/json' } -TimeoutSec 30 }
    catch { throw "Bitrix GET failed for $method (response details suppressed)." }
}

function Invoke-MoyskladGet([string] $path) {
    $allowed = @(
        '/entity/customerorder/metadata/attributes/0ad997c8-8e75-11e3-1ec9-002590a28eca',
        '/entity/customerorder/metadata/attributes/f214f966-dc1a-11f0-0a80-0ef700278459',
        '/entity/uom?limit=1000&offset=0',
        '/context/companysettings/pricetype?limit=1000&offset=0'
    )
    if ($path -notin $allowed -and $path -notmatch '^/context/companysettings/metadata/customEntities/[0-9a-f-]+$' -and $path -notmatch '^/entity/customentity/[0-9a-f-]+\?limit=1000&offset=\d+$') {
        throw 'MySklad endpoint is not allowlisted.'
    }
    $uri = [uri]('https://api.moysklad.ru/api/remap/1.2' + $path)
    if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'api.moysklad.ru' -or $uri.AbsolutePath -notmatch '^/api/remap/1\.2/') {
        throw 'MySklad endpoint failed the host/path guard.'
    }
    $handler = $null
    $client = $null
    $request = $null
    $response = $null
    try {
        $handler = [System.Net.Http.HttpClientHandler]::new()
        $handler.AutomaticDecompression = [System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate
        $client = [System.Net.Http.HttpClient]::new($handler)
        $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $uri)
        # MySklad accepts its exact charset value or no Accept header; omission avoids client normalization.
        $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $script:MoyskladToken)
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $rawBody = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) {
            $errorCodes = @((ConvertFrom-Json -InputObject $rawBody).errors | ForEach-Object { $_.code } | Where-Object { $_ })
            $codeSummary = if ($errorCodes.Count) { '; error codes: ' + ($errorCodes -join ',') } else { '' }
            throw "HTTP $([int]$response.StatusCode)$codeSummary"
        }
        return ConvertFrom-Json -InputObject $rawBody
    } catch {
        $status = if ($_.Exception.Response -and $_.Exception.Response.StatusCode) { [int]$_.Exception.Response.StatusCode } else { 'transport-or-parser' }
        $endpointLabel = if ($path -match '^/entity/customerorder/metadata') { 'customerorder metadata' } elseif ($path -match '^/context/companysettings/metadata/customEntities/') { 'customentity metadata' } elseif ($path -match '^/entity/customentity/.+\?') { 'customentity values' } elseif ($path -like '/entity/uom*') { 'UOM directory' } elseif ($path -like '/context/companysettings/pricetype*') { 'price types' } else { 'allowlisted metadata' }
        $safeError = if ($_.Exception.Message -match '^HTTP [0-9]{3}(; error codes: [0-9,]+)?$') { $_.Exception.Message } else { "status: $status" }
        throw "MySklad GET failed for $endpointLabel ($safeError; response details suppressed)."
    } finally {
        if ($response) { $response.Dispose() }
        if ($request) { $request.Dispose() }
        if ($client) { $client.Dispose() }
        if ($handler) { $handler.Dispose() }
    }
}

function Get-BitrixList([string] $method, [hashtable] $parameters, [string] $rowsName) {
    $all = [System.Collections.Generic.List[object]]::new()
    $start = 0
    do {
        $pageParams = @{} + $parameters
        $pageParams.start = $start
        $response = Invoke-BitrixGet $method $pageParams
        $body = $response.result
        if ($body -is [System.Array]) { $rows = @($body) }
        else { $rows = @($body.$rowsName) }
        foreach ($row in $rows) { $all.Add($row) }
        $next = $response.next
        if ($null -eq $next -and $body -and $body.PSObject.Properties['next']) { $next = $body.next }
        if ($next -is [int] -or $next -match '^\d+$') { $start = [int]$next } else { $start = -1 }
    } while ($start -ge 0 -and $rows.Count -gt 0 -and $all.Count -lt 5000)
    return ,$all.ToArray()
}

$script:BitrixBase = Read-EnvValue $CredentialFile 'BITRIX_WEBHOOK_URL'
$script:MoyskladToken = Read-EnvValue $CredentialFile 'MOYSKLAD_TOKEN'
if (-not $script:BitrixBase -or -not $script:MoyskladToken) { throw 'Required credentials are missing.' }
$script:BitrixBase = $script:BitrixBase.TrimEnd('/') + '/'

# B24 schema and ID/code-only list values. Response labels are held in memory only.
$measures = Get-BitrixList 'catalog.measure.list' @{ select = @('id','code','measureTitle','symbol','symbolIntl','isDefault') } 'measures'
$priceTypes = Get-BitrixList 'catalog.priceType.list' @{ select = @('id','name','base','sort','currency') } 'priceTypes'
$dealFields = Get-BitrixList 'crm.deal.userfield.list' @{} 'result'
$targetFields = @($dealFields | Where-Object { $_.FIELD_NAME -in @('UF_CRM_1766085949','UF_CRM_1766072752') } | ForEach-Object {
    [pscustomobject]@{ field = $_.FIELD_NAME; type = $_.USER_TYPE_ID; multiple = $_.MULTIPLE; required = $_.MANDATORY; iblockId = $_.SETTINGS.IBLOCK_ID }
})

$serviceB24 = Get-BitrixList 'lists.element.get' @{ IBLOCK_TYPE_ID = 'rest_entity'; IBLOCK_ID = 42; SELECT = @('ID','CODE'); } 'elements'
$paymentB24 = Get-BitrixList 'lists.element.get' @{ IBLOCK_TYPE_ID = 'rest_entity'; IBLOCK_ID = 44; SELECT = @('ID','CODE'); } 'elements'

# Current customerorder metadata is read one field at a time. Only type, required and the referenced directory URL/ID survive parsing.
$serviceAttr = Invoke-MoyskladGet '/entity/customerorder/metadata/attributes/0ad997c8-8e75-11e3-1ec9-002590a28eca'
$paymentAttr = Invoke-MoyskladGet '/entity/customerorder/metadata/attributes/f214f966-dc1a-11f0-0a80-0ef700278459'
function Get-DirectoryEvidence($attribute) {
    $refObject = $attribute.customEntityMeta
    $ref = if ($refObject.href) { $refObject.href } elseif ($refObject.meta.href) { $refObject.meta.href } else { $null }
    if (-not $ref) { return $null }
    $refUri = [uri]$ref
    if ($refUri.Host -ne 'api.moysklad.ru' -or $refUri.AbsolutePath -notmatch '^/api/remap/1\.2/context/companysettings/metadata/customEntities/([0-9a-f-]+)$') { return $null }
    $directoryId = $Matches[1]
    $metadata = Invoke-MoyskladGet "/context/companysettings/metadata/customEntities/$directoryId"
    $values = [System.Collections.Generic.List[object]]::new()
    $offset = 0
    do {
        $page = Invoke-MoyskladGet "/entity/customentity/$directoryId`?limit=1000&offset=$offset"
        foreach ($row in @($page.rows)) { if ($row.id) { $values.Add([pscustomobject]@{ id = [string]$row.id; archived = $row.archived }) } }
        $total = [int]$page.meta.size
        $offset += 1000
    } while ($offset -lt $total -and $offset -lt 100000)
    return [pscustomobject]@{ id = $directoryId; type = $attribute.type; required = $attribute.required; valueCount = $values.Count; values = @($values.ToArray()); metadataType = $metadata.meta.type }
}
$serviceDirectory = Get-DirectoryEvidence $serviceAttr
$paymentDirectory = Get-DirectoryEvidence $paymentAttr

function Get-IdPairs($b24Rows, $msValues) {
    $msIds = @($msValues | ForEach-Object { $_.id })
    $idSet = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($id in $msIds) { [void]$idSet.Add([string]$id) }
    $pairs = [System.Collections.Generic.List[object]]::new()
    $validCodeCount = 0
    $unmatchedB24Ids = [System.Collections.Generic.List[string]]::new()
    foreach ($row in $b24Rows) {
        $code = [string]$row.CODE
        if ($code -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
            $validCodeCount++
            if ($idSet.Contains($code)) { $pairs.Add([pscustomobject]@{ b24Id = [string]$row.ID; moyskladId = $code }) }
            else { $unmatchedB24Ids.Add([string]$row.ID) }
        }
    }
    $matchedIds = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($pair in $pairs) { [void]$matchedIds.Add([string]$pair.moyskladId) }
    $unmatchedMsIds = @($msIds | Where-Object { -not $matchedIds.Contains([string]$_) })
    return [pscustomobject]@{ b24ValueCount = $b24Rows.Count; uuidCodeCount = $validCodeCount; moyskladValueCount = $msIds.Count; matchedPairCount = $pairs.Count; unmatchedB24UuidCount = $validCodeCount - $pairs.Count; unmatchedMoyskladIdCount = $msIds.Count - $pairs.Count; pairs = @($pairs.ToArray()); unmatchedB24Ids = @($unmatchedB24Ids.ToArray()); unmatchedMoyskladIds = $unmatchedMsIds }
}

function Get-CodePairs($b24Rows, $msRows) {
    $byCode = @{}
    foreach ($row in $msRows) {
        $code = [string]$row.code
        if ($code) {
            if (-not $byCode.ContainsKey($code)) { $byCode[$code] = [System.Collections.Generic.List[object]]::new() }
            $byCode[$code].Add($row)
        }
    }
    $pairs = [System.Collections.Generic.List[object]]::new()
    $ambiguous = 0
    foreach ($row in $b24Rows) {
        $code = [string]$row.code
        if ($code -and $byCode.ContainsKey($code)) {
            if ($byCode[$code].Count -eq 1) { $pairs.Add([pscustomobject]@{ b24Id = [string]$row.id; moyskladId = [string]$byCode[$code][0].id; code = $code }) }
            else { $ambiguous++ }
        }
    }
    return [pscustomobject]@{ exactUniqueCodePairs = @($pairs.ToArray()); ambiguousB24Measures = $ambiguous }
}

$uom = Invoke-MoyskladGet '/entity/uom?limit=1000&offset=0'
$msPriceTypes = Invoke-MoyskladGet '/context/companysettings/pricetype?limit=1000&offset=0'

$result = [ordered]@{
    method = 'GET only; no write-capable method is in the allowlist'
    bitrix = [ordered]@{
        measures = @($measures | ForEach-Object { [ordered]@{ id = $_.id; code = $_.code; title = $_.measureTitle; symbol = $_.symbol; symbolIntl = $_.symbolIntl; isDefault = $_.isDefault } })
        priceTypes = @($priceTypes | ForEach-Object { [ordered]@{ id = $_.id; name = $_.name; base = $_.base; sort = $_.sort; currency = $_.currency } })
        dealUserFields = $targetFields
    }
    shape = [ordered]@{ serviceCustomEntityMetaHref = $serviceAttr.customEntityMeta.href }
    uomCodePairs = Get-CodePairs $measures $uom.rows
    moysklad = [ordered]@{
        uom = @($uom.rows | ForEach-Object { [ordered]@{ id = $_.id; name = $_.name; code = $_.code; archived = $_.archived } })
        priceTypes = @($msPriceTypes | ForEach-Object { [ordered]@{ id = $_.id; name = $_.name; externalCode = $_.externalCode } })
        service = [ordered]@{ fieldId = $serviceAttr.id; type = $serviceAttr.type; required = $serviceAttr.required; directoryId = $serviceDirectory.id; valueCount = $serviceDirectory.valueCount; values = if ($serviceDirectory) { Get-IdPairs $serviceB24 $serviceDirectory.values } else { $null } }
        paymentMethod = [ordered]@{ fieldId = $paymentAttr.id; type = $paymentAttr.type; required = $paymentAttr.required; directoryId = $paymentDirectory.id; valueCount = $paymentDirectory.valueCount; values = if ($paymentDirectory) { Get-IdPairs $paymentB24 $paymentDirectory.values } else { $null } }
    }
}
$result | ConvertTo-Json -Depth 10
$script:MoyskladToken = $null
$script:BitrixBase = $null
