// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

/* tslint:disable:no-bitwise */
/* tslint:disable:member-ordering */

import { AstPackage } from '../ast/AstPackage';
import { ApiDefinitionReference, IApiDefinitionReferenceParts } from '../ApiDefinitionReference';
import { Token, TokenType } from './Token';
import { Tokenizer } from './Tokenizer';
import { ExtractorContext } from '../ExtractorContext';
import { ResolvedApiItem } from '../ResolvedApiItem';
import { ReleaseTag } from './ReleaseTag';
import { MarkupElement, MarkupBasicElement, IMarkupApiLink, MarkupLinkTextElement } from '../markup/MarkupElement';
import { Markup } from '../markup/Markup';
import { IParsedPackageName } from '@microsoft/node-core-library';
import { AstItemKind } from '../ast/AstItem';
import { IApiItemReference } from '../api/ApiItem';

/**
 * A dependency for ApiDocumentation constructor that abstracts away the function
 * of resolving an API definition reference.
 *
 * @internalremarks reportError() will be called if the apiDefinitionRef is to a non local
 * item and the package of that non local item can not be found.
 * If there is no package given and an  item can not be found we will return undefined.
 * Once we support local references, we can be sure that reportError will only be
 * called once if the item can not be found (and undefined will be returned by the reference
 * function).
 */
export interface IReferenceResolver {
  resolve(
    apiDefinitionRef: ApiDefinitionReference,
    astPackage: AstPackage,
    warnings: string[]): ResolvedApiItem | undefined;
}

/**
 * Used by ApiDocumentation to represent the AEDoc description for a function parameter.
 */
export interface IAedocParameter {
  name: string;
  description: MarkupBasicElement[];
}

export class ApiDocumentation {
  // For guidance about using these tags, please see this documentation:
  // https://github.com/Microsoft/web-build-tools/wiki/API-Extractor-~-AEDoc-tags
  private static _allowedRegularAedocTags: string[] = [
    // (alphabetical order)
    '@alpha',
    '@beta',
    '@betadocumentation',
    '@eventproperty',
    '@internal',
    '@internalremarks',
    '@override',
    '@packagedocumentation',
    '@param',
    '@preapproved',
    '@public',
    '@returns',
    '@deprecated',
    '@readonly',
    '@remarks',
    '@sealed',
    '@virtual'
  ];

  private static _allowedInlineAedocTags: string[] = [
    // (alphabetical order)
    '@inheritdoc',
    '@link'
  ];

  /**
   * The original AEDoc comment, with the "/**" characters already removed.
   *
   * Example: "This is a summary. \{\@link a\} \@remarks These are remarks."
   */
  public originalAedoc: string;

   /**
   * docCommentTokens that are parsed into Doc Elements.
   */
  public summary: MarkupElement[];
  public deprecatedMessage: MarkupBasicElement[];
  public remarks: MarkupElement[];
  public returnsMessage: MarkupBasicElement[];
  public parameters: { [name: string]: IAedocParameter; };

  /**
   * A list of \@link elements to be post-processed after all basic documentation has been created
   * for all items in the project.  We save the processing for later because we need ReleaseTag
   * information before we can determine whether a link element is valid.
   * Example: If API item A has a \@link in its documentation to API item B, then B must not
   * have ReleaseTag.Internal.
   */
  public incompleteLinks: IMarkupApiLink[];

  /**
   * A list of 'Token' objects that have been recognized as \@inheritdoc tokens that will be processed
   * after the basic documentation for all API items is complete. We postpone the processing
   * because we need ReleaseTag information before we can determine whether an \@inheritdoc token
   * is valid.
   */
  private incompleteInheritdocs: Token[];

  /**
   * A "release tag" is an AEDoc tag which indicates whether this definition
   * is considered Public API for third party developers, as well as its release
   * stage (alpha, beta, etc).
   */
  public releaseTag: ReleaseTag;

  /**
   * True if the "\@preapproved" tag was specified.
   * Indicates that this internal API is exempt from further reviews.
   */
  public preapproved: boolean | undefined;

  /**
   * True if the "\@packagedocumentation" tag was specified.
   */
  public isPackageDocumentation: boolean | undefined;

  /**
   * True if the documentation content has not been reviewed yet.
   */
  public isDocBeta: boolean | undefined;

  /**
   * True if the \@eventproperty tag was specified.  This means class/interface property
   * represents and event.  It should be a read-only property that returns a user-defined class
   * with operations such as addEventHandler() or removeEventHandler().
   */
  public isEventProperty: boolean | undefined;

  /**
   * True if the \@inheritdoc tag was specified.
   */
  public isDocInherited: boolean | undefined;

  /**
   * True if the \@inheritdoc tag was specified and is inheriting from a target object
   * that was marked as \@deprecated.
   */
  public isDocInheritedDeprecated: boolean | undefined;

  /**
   * True if the \@readonly tag was specified.
   */
  public hasReadOnlyTag: boolean | undefined;

  public warnings: string[];

  /**
   * Whether the "\@sealed" AEDoc tag was specified.
   */
  public isSealed: boolean;

  /**
   * Whether the "\@virtual" AEDoc tag was specified.
   */
  public isVirtual: boolean;

  /**
   * Whether the "\@override" AEDoc tag was specified.
   */
  public isOverride: boolean;

  /**
   * A function type interface that abstracts away resolving
   * an API definition reference to an item that has friendly
   * accessible AstItem properties.
   *
   * Ex: this is useful in the case of parsing inheritdoc expressions,
   * in the sense that we do not know if we the inherited documentation
   * is coming from an AstItem or a ApiItem.
   */
  public referenceResolver: IReferenceResolver;

  /**
   * We need the extractor to access the package that this AstItem
   * belongs to in order to resolve references.
   */
  public context: ExtractorContext;

  /**
   * True if any errors were encountered while parsing the AEDoc tokens.
   * This is used to suppress other "collateral damage" errors, e.g. if "@public" was
   * misspelled then we shouldn't also complain that the "@public" tag is missing.
   */
  public failedToParse: boolean;

  public readonly reportError: (message: string) => void;

  constructor(originalAedoc: string,
    referenceResolver: IReferenceResolver,
    context: ExtractorContext,
    errorLogger: (message: string) => void,
    warnings: string[]) {

    this.reportError = (message: string) => {
      errorLogger(message);
      this.failedToParse = true;
    };

    this.originalAedoc = originalAedoc;
    this.referenceResolver = referenceResolver;
    this.context = context;
    this.reportError = errorLogger;
    this.parameters = {};
    this.warnings = warnings;

    this.isSealed = false;
    this.isVirtual = false;
    this.isOverride = false;

    this._parseDocs();
  }

  /**
   * Executes the implementation details involved in completing the documentation initialization.
   * Currently completes link and inheritdocs.
   */
  public completeInitialization(warnings: string[]): void {
    // Ensure links are valid
    this._completeLinks();
    // Ensure inheritdocs are valid
    this._completeInheritdocs(warnings);
  }

  protected _parseDocs(): void {
    this.summary = [];
    this.returnsMessage = [];
    this.deprecatedMessage = [];
    this.remarks = [];
    this.incompleteLinks = [];
    this.incompleteInheritdocs = [];
    this.releaseTag = ReleaseTag.None;
    const tokenizer: Tokenizer = new Tokenizer(this.originalAedoc, this.reportError);
    this.summary = ApiDocumentation._parseAndNormalize(this, tokenizer);

    let releaseTagCount: number = 0;
    let parsing: boolean = true;

      while (parsing) {
      const token: Token | undefined = tokenizer.peekToken();
      if (!token) {
        parsing = false; // end of stream
        // Report error if @inheritdoc is deprecated but no @deprecated tag present here
        if (this.isDocInheritedDeprecated && this.deprecatedMessage.length === 0) {
          // if this documentation inherits docs from a deprecated API item, then
          // this documentation must either have a deprecated message or it must
          // not use the @inheritdoc and copy+paste the documentation
          this.reportError(`A deprecation message must be included after the @deprecated tag.`);
        }
        break;
      }

      if (token.type === TokenType.BlockTag) {
        switch (token.tag) {
          case '@remarks':
            tokenizer.getToken();
            this._checkInheritDocStatus(token.tag);
            this.remarks = ApiDocumentation._parseAndNormalize(this, tokenizer);
            break;
          case '@returns':
            tokenizer.getToken();
            this._checkInheritDocStatus(token.tag);
            this.returnsMessage = ApiDocumentation._parseAndNormalize(this, tokenizer);
            break;
          case '@param':
            tokenizer.getToken();
            this._checkInheritDocStatus(token.tag);
            const param: IAedocParameter | undefined = this._parseParam(tokenizer);
            if (param) {
               this.parameters[param.name] = param;
            }
            break;
          case '@deprecated':
            tokenizer.getToken();
            this.deprecatedMessage = ApiDocumentation._parseAndNormalize(this, tokenizer);
            if (!this.deprecatedMessage || this.deprecatedMessage.length === 0) {
              this.reportError(`deprecated description required after @deprecated AEDoc tag.`);
            }
            break;
          case '@internalremarks':
            // parse but discard
            tokenizer.getToken();
            ApiDocumentation._parse(this, tokenizer);
            break;
          case '@public':
            tokenizer.getToken();
            this.releaseTag = ReleaseTag.Public;
            ++releaseTagCount;
            break;
          case '@internal':
            tokenizer.getToken();
            this.releaseTag = ReleaseTag.Internal;
            ++releaseTagCount;
            break;
          case '@alpha':
            tokenizer.getToken();
            this.releaseTag = ReleaseTag.Alpha;
            ++releaseTagCount;
            break;
          case '@beta':
            tokenizer.getToken();
            this.releaseTag = ReleaseTag.Beta;
            ++releaseTagCount;
            break;
          case '@preapproved':
            tokenizer.getToken();
            this.preapproved = true;
            break;
          case '@packagedocumentation':
            tokenizer.getToken();
            this.isPackageDocumentation = true;
            break;
          case '@readonly':
            tokenizer.getToken();
            this.hasReadOnlyTag = true;
            break;
          case '@betadocumentation':
            tokenizer.getToken();
            this.isDocBeta = true;
            break;
          case '@eventproperty':
            tokenizer.getToken();
            this.isEventProperty = true;
            break;
          case '@sealed':
            tokenizer.getToken();
            this.isSealed = true;
            break;
         case '@virtual':
            tokenizer.getToken();
            this.isVirtual = true;
            break;
          case '@override':
            tokenizer.getToken();
            this.isOverride = true;
            break;
          default:
            tokenizer.getToken();
            this._reportBadAedocTag(token);
        }
      } else if (token.type === TokenType.InlineTag) {
        switch (token.tag) {
          case '@inheritdoc':
            ApiDocumentation._parse(this, tokenizer);
            break;
          case '@link':
            ApiDocumentation._parse(this, tokenizer);
            break;
          default:
            tokenizer.getToken();
            this._reportBadAedocTag(token);
            break;
        }
      } else if (token.type === TokenType.Text)  {
        tokenizer.getToken();

        if (token.text.trim().length !== 0) {
          // Shorten "This is too long text" to "This is..."
          const MAX_LENGTH: number = 40;
          let problemText: string = token.text.trim();
          if (problemText.length > MAX_LENGTH) {
            problemText = problemText.substr(0, MAX_LENGTH - 3).trim() + '...';
          }
          this.reportError(`Unexpected text in AEDoc comment: "${problemText}"`);
        }
      } else {
        tokenizer.getToken();
        // This would be a program bug
        this.reportError(`Unexpected token: ${token.type} ${token.tag} "${token.text}"`);
      }
    }

    if (releaseTagCount > 1) {
      this.reportError('More than one release tag (@alpha, @beta, etc) was specified');
    }

    if (this.preapproved && this.releaseTag !== ReleaseTag.Internal) {
      this.reportError('The @preapproved tag may only be applied to @internal definitions');
      this.preapproved = false;
    }

    if (this.isSealed && this.isVirtual) {
      this.reportError('The @sealed and @virtual tags may not be used together');
    }

    if (this.isVirtual && this.isOverride) {
      this.reportError('The @virtual and @override tags may not be used together');
    }
  }

  protected _parseParam(tokenizer: Tokenizer): IAedocParameter | undefined {
    const paramDescriptionToken: Token | undefined = tokenizer.getToken();
    if (!paramDescriptionToken) {
      this.reportError('The @param tag is missing a parameter description');
      return undefined;
    }
    const hyphenIndex: number = paramDescriptionToken ? paramDescriptionToken.text.indexOf('-') : -1;
    if (hyphenIndex < 0) {
      this.reportError('The @param tag is missing the hyphen that delimits the parameter name '
        + ' and description');
      return undefined;
    } else {
      const name: string = paramDescriptionToken.text.slice(0, hyphenIndex).trim();
      const comment: string = paramDescriptionToken.text.substr(hyphenIndex + 1).trim();

      if (!comment) {
        this.reportError('The @param tag is missing a parameter description');
        return undefined;
      }

      const commentTextElements: MarkupBasicElement[] = Markup.createTextElements(comment);
      // Full param description may contain additional Tokens (Ex: @link)
      const remainingElements: MarkupBasicElement[] = ApiDocumentation._parse(this, tokenizer);
      const descriptionElements: MarkupBasicElement[] = commentTextElements.concat(remainingElements);
      Markup.normalize(descriptionElements);

      const paramDocElement: IAedocParameter = {
        name: name,
        description: descriptionElements
      };
      return paramDocElement;
    }
  }

  /**
   * A processing of linkDocElements that refer to an ApiDefinitionReference. This method
   * ensures that the reference is to an API item that is not 'Internal'.
   */
  private _completeLinks(): void {
    for ( ; ; ) {
      const codeLink: IMarkupApiLink | undefined = this.incompleteLinks.pop();
      if (!codeLink) {
        break;
      }

      const parts: IApiDefinitionReferenceParts = {
        scopeName: codeLink.target.scopeName,
        packageName: codeLink.target.packageName,
        exportName: codeLink.target.exportName,
        memberName: codeLink.target.memberName
      };

      const apiDefinitionRef: ApiDefinitionReference = ApiDefinitionReference.createFromParts(parts);
      const resolvedAstItem: ResolvedApiItem | undefined =  this.referenceResolver.resolve(
        apiDefinitionRef,
        this.context.package,
        this.warnings
      );

      // If the apiDefinitionRef can not be found the resolvedAstItem will be
      // undefined and an error will have been reported via this.reportError
      if (resolvedAstItem) {
        if (resolvedAstItem.releaseTag === ReleaseTag.Internal
          || resolvedAstItem.releaseTag === ReleaseTag.Alpha) {

          this.reportError('The {@link} tag references an @internal or @alpha API item, '
            + 'which will not appear in the generated documentation');
        }
      }
    }
  }

  /**
   * A processing of inheritdoc 'Tokens'. This processing occurs after we have created documentation
   * for all API items.
   */
  private _completeInheritdocs(warnings: string[]): void {
    for ( ; ; ) {
      const token: Token | undefined = this.incompleteInheritdocs.pop();
      if (!token) {
        break;
      }

      ApiDocumentation._parseInheritDoc(this, token, warnings);
    }
  }

  private _reportBadAedocTag(token: Token): void {
    const supportsRegular: boolean = ApiDocumentation._allowedRegularAedocTags.indexOf(token.tag) >= 0;
    const supportsInline: boolean = ApiDocumentation._allowedInlineAedocTags.indexOf(token.tag) >= 0;

    if (!supportsRegular && !supportsInline) {
      this.reportError(`The JSDoc tag \"${token.tag}\" is not supported by AEDoc`);
      return;
    }

    if (token.type === TokenType.InlineTag && !supportsInline) {
      this.reportError(`The AEDoc tag \"${token.tag}\" must use the inline tag notation (i.e. with curly braces)`);
      return;
    }
    if (token.type === TokenType.BlockTag && !supportsRegular) {
      this.reportError(`The AEDoc tag \"${token.tag}\" must use the block tag notation (i.e. no curly braces)`);
      return;
    }

    this.reportError(`The AEDoc tag \"${token.tag}\" is not supported in this context`);
    return;
  }

  private _checkInheritDocStatus(aedocTag: string): void {
    if (this.isDocInherited) {
      this.reportError(`The ${aedocTag} tag may not be used because this state is provided by the @inheritdoc target`);
    }
  }

  /**
   * Matches one of:
   * - an escape sequence, i.e. backslash followed by a non-alphabetical character
   * - an HTML opening tag such as `<td>` or `<img src="example.gif" />`
   * - an HTML opening tag such as `<td>` or `<img src='example.gif' />`
   * - an HTML closing tag such `</td>`
   *
   * Note that the greedy nature of the RegExp ensures that `\<td>` will get interpreted
   * as an escaped "<", whereas `\\<td>` will get interpreted as an escaped backslash
   * followed by an HTML element.
   */
  private static _htmlTagRegExp: RegExp
    = /\\[^a-zA-Z\s]|<[\w\-]+(?:\s+[\w\-]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?>|<\/[\w\-]+>/g;

  /**
   * Used to validate the display text for an \@link tag.  The display text can contain any
   * characters except for certain AEDoc delimiters: "@", "|", "{", "}".
   * This RegExp matches the first bad character.
   * Example: "Microsoft's {spec}" --> "{"
   */
  private static _displayTextBadCharacterRegEx: RegExp = /[@|{}]/;

  /**
   * Matches a href reference. This is used to get an idea whether a given reference is for an href
   * or an API definition reference.
   *
   * For example, the following would be matched:
   * 'http://'
   * 'https://'
   *
   * The following would not be matched:
   * '@microsoft/sp-core-library:Guid.newGuid'
   * 'Guid.newGuid'
   * 'Guid'
   */
  private static _hrefRegEx: RegExp = /^[a-z]+:\/\//;

  private static _parse(documentation: ApiDocumentation, tokenizer: Tokenizer): MarkupBasicElement[] {

    const markupElements: MarkupBasicElement[] = [];
    let parsing: boolean = true;
    let token: Token | undefined;

    while (parsing) {
      token = tokenizer.peekToken();
      if (!token) {
        parsing = false; // end of stream
        break;
      }

      if (token.type === TokenType.BlockTag) {
        parsing = false; // end of summary tokens
      } else if (token.type === TokenType.InlineTag) {
        switch (token.tag) {
          case '@inheritdoc':
            tokenizer.getToken();
            if (markupElements.length > 0 ||  documentation.summary.length > 0) {
              documentation.reportError('A summary block is not allowed here,'
                + ' because the @inheritdoc target provides the summary');
            }
            documentation.incompleteInheritdocs.push(token);
            documentation.isDocInherited = true;
            break;
          case '@link' :
            const linkMarkupElement: MarkupElement | undefined = this._parseLinkTag(documentation, token);
            if (linkMarkupElement) {
              // Push to linkMarkupElement to retain position in the documentation
              markupElements.push(linkMarkupElement);
              if (linkMarkupElement.kind === 'api-link') {
                documentation.incompleteLinks.push(linkMarkupElement);
              }
            }
            tokenizer.getToken(); // get the link token
            break;
          default:
            parsing = false;
            break;
        }
      } else if (token.type === TokenType.Text) {
        tokenizer.getToken();

        markupElements.push(...ApiDocumentation._parseMarkdownishText(token.text));
      } else {
        documentation.reportError(`Unidentifiable Token ${token.type} ${token.tag} "${token.text}"`);
      }
    }

    return markupElements;
  }

  private static _parseAndNormalize(documentation: ApiDocumentation, tokenizer: Tokenizer): MarkupBasicElement[] {
    const markupElements: MarkupBasicElement[] = ApiDocumentation._parse(documentation, tokenizer);
    Markup.normalize(markupElements);
    return markupElements;
  }

  /**
   * This method parses the semantic information in an \@link JSDoc tag, creates and returns a
   * MarkupElement with the corresponding information. If the corresponding inline tag \@link is
   * not formatted correctly an error will be reported and undefined is returned.
   *
   * The format for the \@link tag is {\@link URL or API defintion reference | display text}, where
   * the '|' is only needed if the optional display text is given.
   *
   * Examples:
   * \{@link http://microsoft.com | microsoft home \}
   * \{@link http://microsoft.com \}
   * \{@link @microsoft/sp-core-library:Guid.newGuid | new Guid Object \}
   * \{@link @microsoft/sp-core-library:Guid.newGuid \}
   */
  private static _parseLinkTag(documentation: ApiDocumentation, tokenItem: Token): MarkupBasicElement | undefined {
    if (!tokenItem.text) {
      documentation.reportError('The {@link} tag must include a URL or API item reference');
      return undefined;
    }

    // Make sure there are no extra pipes
    const pipeSplitContent: string[] = tokenItem.text.split('|').map(value => {
      return value ? value.trim() : value;
    });

    if (pipeSplitContent.length > 2) {
      documentation.reportError('The {@link} tag contains more than one pipe character ("|")');
      return undefined;
    }

    const addressPart: string = pipeSplitContent[0];
    const displayTextPart: string = pipeSplitContent.length > 1 ? pipeSplitContent[1] : '';

    let displayTextElements: MarkupLinkTextElement[];

    // If a display name is given, ensure it only contains characters for words.
    if (displayTextPart) {
      const match: RegExpExecArray | null = this._displayTextBadCharacterRegEx.exec(displayTextPart);
      if (match) {
        documentation.reportError(`The {@link} tag\'s display text contains an unsupported`
          + ` character: "${match[0]}"`);
        return undefined;
      }
      // Full match is valid text
      displayTextElements = Markup.createTextElements(displayTextPart);
    } else {
      // If the display text is not explicitly provided, then use the address as the display text
      displayTextElements = Markup.createTextElements(addressPart);
    }

    // Try to guess if the tokenContent is a link or API definition reference
    let linkMarkupElement: MarkupBasicElement;
    if (this._hrefRegEx.test(addressPart)) {
      // Make sure only a single URL is given
      if (addressPart.indexOf(' ') >= 0) {
        documentation.reportError('The {@link} tag contains additional spaces after the URL;'
          + ' if the URL contains spaces, encode them using %20; for display text, use a pipe delimiter ("|")');
        return undefined;
      }

      linkMarkupElement = Markup.createWebLink(displayTextElements, addressPart);
    } else {
      // we are processing an API definition reference
      const apiDefitionRef: ApiDefinitionReference | undefined = ApiDefinitionReference.createFromString(
        addressPart,
        documentation.reportError
      );

      // Once we can locate local API definitions, an error should be reported here if not found.
      if (!apiDefitionRef) {
        return undefined;
      }

      const normalizedApiLink: IApiItemReference = apiDefitionRef.toApiItemReference();
      if (!normalizedApiLink.packageName) {
        if (!documentation.context.packageName) {
          throw new Error('Unable to resolve API reference without a package name');
        }

        // If the package name is unspecified, assume it is the current package
        const parsedPackageName: IParsedPackageName = documentation.context.parsedPackageName;

        normalizedApiLink.scopeName = parsedPackageName.scope;
        normalizedApiLink.packageName = parsedPackageName.unscopedName;
      }

      linkMarkupElement = Markup.createApiLink(displayTextElements, normalizedApiLink);
    }

    return linkMarkupElement;
  }

  /**
   * This method parses the semantic information in an \@inheritdoc JSDoc tag and sets
   * all the relevant documenation properties from the inherited doc onto the documenation
   * of the current api item.
   *
   * The format for the \@inheritdoc tag is {\@inheritdoc scopeName/packageName:exportName.memberName}.
   * For more information on the format see IInheritdocRef.
   */
  private static _parseInheritDoc(documentation: ApiDocumentation, token: Token, warnings: string[]): void {

    // Check to make sure the API definition reference is at most one string
    const tokenChunks: string[] = token.text.split(' ');
    if (tokenChunks.length > 1) {
      documentation.reportError('The {@inheritdoc} tag does not match the expected pattern' +
        ' "{@inheritdoc @scopeName/packageName:exportName}"');
      return;
    }

    // Create the IApiDefinitionReference object
    // Deconstruct the API reference expression 'scopeName/packageName:exportName.memberName'
    const apiDefinitionRef: ApiDefinitionReference | undefined = ApiDefinitionReference.createFromString(
      token.text,
      documentation.reportError
    );
    // if API reference expression is formatted incorrectly then apiDefinitionRef will be undefined
    if (!apiDefinitionRef) {
      documentation.reportError(`Incorrectly formatted API item reference: "${token.text}"`);
      return;
    }

    // Atempt to locate the apiDefinitionRef
    const resolvedAstItem: ResolvedApiItem | undefined = documentation.referenceResolver.resolve(
      apiDefinitionRef,
      documentation.context.package,
      warnings
    );

    // If no resolvedAstItem found then nothing to inherit
    // But for the time being set the summary to a text object
    if (!resolvedAstItem) {
      documentation.summary = Markup.createTextElements(`See documentation for ${tokenChunks[0]}`);
      return;
    }

    // We are going to copy the resolvedAstItem's documentation
    // We must make sure it's documentation can be completed,
    // if we cannot, an error will be reported viathe documentation error handler.
    // This will only be the case our resolvedAstItem was created from a local
    // AstItem. Resolutions from JSON will have an undefined 'astItem' property.
    // Example: a circular reference will report an error.
    if (resolvedAstItem.astItem) {
      resolvedAstItem.astItem.completeInitialization();
    }

    // inheritdoc found, copy over IApiBaseDefinition properties
    documentation.summary =  resolvedAstItem.summary;
    documentation.remarks = resolvedAstItem.remarks;

    // Copy over detailed properties if neccessary
    // Add additional cases if needed
    switch (resolvedAstItem.kind) {
      case AstItemKind.Function:
        documentation.parameters = resolvedAstItem.params || { };
        documentation.returnsMessage = resolvedAstItem.returnsMessage || [];
        break;
      case AstItemKind.Method:
      case AstItemKind.Constructor:
        documentation.parameters = resolvedAstItem.params || { };
        documentation.returnsMessage = resolvedAstItem.returnsMessage || [];
        break;
    }

    // Check if inheritdoc is depreacted
    // We need to check if this documentation has a deprecated message
    // but it may not appear until after this token.
    if (resolvedAstItem.deprecatedMessage && resolvedAstItem.deprecatedMessage.length > 0) {
      documentation.isDocInheritedDeprecated = true;
    }
  }

  /**
   * This is a temporary workaround until the TSDoc parser is integrated.  "Markdownish"
   * text can have:
   * - paragraphs delimited using double-newlines --> IMarkupParagraph
   * - HTML tags (as in the CommonMark spec) --> IMarkupHtmlTag
   * - Backslash as an escape character
   */
  private static _parseMarkdownishText(text: string): MarkupBasicElement[] {
    const result: MarkupBasicElement[] = [];

    if (text) {
      // Split up the paragraphs
      for (const paragraph of text.split(/\n\s*\n/g)) {
        if (result.length > 0) {
          result.push(Markup.PARAGRAPH);
        }

        // Clone the original RegExp so we get our own state machine
        const htmlTagRegExp: RegExp = new RegExp(ApiDocumentation._htmlTagRegExp);

        let lastMatchEndIndex: number = 0;
        let accumulatedText: string = '';

        // Find the HTML tags and backslash sequences in the paragraph string
        let match: RegExpExecArray | null;
        while (match = htmlTagRegExp.exec(paragraph)) {
          // Was there any plain text between this match and the previous one?
          // If so accumulate it
          const textBeforeMatch: string = paragraph.substring(lastMatchEndIndex, match.index);
          accumulatedText += textBeforeMatch;

          // What did we match?
          const matchedText: string = match[0];
          if (matchedText[0] === '\\') {
            // It's a backslash escape, so accumulate the subsequent character (but not the backslash itself)
            accumulatedText += matchedText[1];
          } else {
            // It's an opening or closing HTML tag

            // First push any text we accumulated
            result.push(...Markup.createTextElements(accumulatedText));
            accumulatedText = '';

            // Then push the HTML tag
            result.push(Markup.createHtmlTag(matchedText));
          }

          lastMatchEndIndex = match.index + matchedText.length;
        }
        // Push any remaining text
        accumulatedText += paragraph.substring(lastMatchEndIndex);

        result.push(...Markup.createTextElements(accumulatedText));
        accumulatedText = '';
      }
    }

    return result;
  }

}
